import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Stellar-Pay-Signature';

/** Generates a webhook signing secret (`whsec_` + 32 random bytes). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Encrypts a webhook secret at rest with AES-256-GCM.
 * Output: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
 */
export function encryptSecret(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, keyHex: string): string {
  const [version, iv, tag, ct] = enc.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret encoding');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** `hex(HMAC-SHA256(secret, "<t>.<rawBody>"))` */
export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Builds the `Stellar-Pay-Signature: t=<unix>,v1=<hex>` header value. */
export function signatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

/**
 * Verifies a signature header against the raw body. Used by tests and
 * mirrored by the SDK's `webhooks.verify`.
 */
export function verifySignatureHeader(
  header: string,
  rawBody: string,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
