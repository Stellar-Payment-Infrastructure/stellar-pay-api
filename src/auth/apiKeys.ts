import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPES = ['payments:read', 'payments:write', 'webhooks:read', 'webhooks:write'] as const;
export type Scope = (typeof SCOPES)[number];

export const KEY_PREFIX = 'sk_test_';
/** Visible prefix length stored for lookup and display (`sk_test_` + 8 chars). */
export const LOOKUP_PREFIX_LENGTH = KEY_PREFIX.length + 8;

/** HMAC-SHA256 of the key with a server-side pepper, hex encoded. */
export function hashApiKey(key: string, pepper: string): string {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

/** Generates a new secret key. The plain key is returned once and never stored. */
export function generateApiKey(pepper: string): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, LOOKUP_PREFIX_LENGTH), hash: hashApiKey(key, pepper) };
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Cheap shape check before touching the database. */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX) && /^sk_test_[A-Za-z0-9_-]{43}$/.test(value);
}
