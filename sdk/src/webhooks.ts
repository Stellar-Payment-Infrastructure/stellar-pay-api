/**
 * Webhook signature verification (Node.js; uses `node:crypto`).
 *
 * ```ts
 * import { webhooks } from 'stellar-pay-sdk/webhooks';
 * // rawBody MUST be the unparsed request body (string or Buffer)
 * const event = webhooks.verify(rawBody, req.headers['stellar-pay-signature'], process.env.WH_SECRET!, { toleranceSec: 300 });
 * // dedupe by event.id (delivery is at-least-once), then handle event.type
 * ```
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent } from './types.js';

export const SIGNATURE_HEADER = 'stellar-pay-signature';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface VerifyOptions {
  /** Max allowed clock difference in seconds (default 300). */
  toleranceSec?: number;
  /** Current unix time in seconds (for tests). */
  now?: number;
}

function parseHeader(header: string): { t: number; signatures: string[] } {
  let t = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = Number(v);
    if (k === 'v1') signatures.push(v);
  }
  return { t, signatures };
}

/** `hex(HMAC-SHA256(secret, "<t>.<rawBody>"))` */
export function computeSignature(secret: string, timestamp: number, rawBody: string | Uint8Array): string {
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/**
 * Verifies `Stellar-Pay-Signature: t=<unix>,v1=<hex>` against the raw body and
 * returns the parsed event. Throws `WebhookVerificationError` otherwise.
 */
export function verify(
  rawBody: string | Uint8Array,
  header: string | string[] | undefined,
  secret: string,
  opts: VerifyOptions = {},
): WebhookEvent {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new WebhookVerificationError('missing signature header');
  if (!secret) throw new WebhookVerificationError('missing webhook secret');
  const { t, signatures } = parseHeader(value);
  if (!Number.isInteger(t) || signatures.length === 0) throw new WebhookVerificationError('malformed signature header');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) throw new WebhookVerificationError('timestamp outside tolerance');
  const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
  const ok = signatures.some((s) => {
    if (!/^[0-9a-f]{64}$/.test(s)) return false;
    return timingSafeEqual(expected, Buffer.from(s, 'hex'));
  });
  if (!ok) throw new WebhookVerificationError('signature mismatch');
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  try {
    return JSON.parse(body) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('body is not JSON');
  }
}

/** Builds a header value (useful for testing your own handler). */
export function sign(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

export const webhooks = { verify, sign, computeSignature, SIGNATURE_HEADER };
