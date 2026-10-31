import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, hashesEqual, looksLikeApiKey } from './auth/apiKeys.js';
import { ConfigError, loadConfig, PUBNET_PASSPHRASE } from './config.js';
import { canTransition, eventsForTransition } from './payments/stateMachine.js';
import { computeSignature, decryptSecret, encryptSecret, signatureHeader, verifySignatureHeader } from './webhooks/crypto.js';
import { MAX_ATTEMPTS, nextAttemptDelayMs, RETRY_DELAYS_SEC } from './webhooks/dispatcher.js';
import { isBlockedAddress, parseWebhookUrl, resolveSafeTarget } from './webhooks/ssrf.js';
import { testConfig } from '../test/helpers.js';

describe('api keys', () => {
  it('generates keys whose plain value is never what is stored', () => {
    const { key, prefix, hash } = generateApiKey('p'.repeat(32));
    expect(looksLikeApiKey(key)).toBe(true);
    expect(key.startsWith(prefix)).toBe(true);
    expect(hash).not.toContain(key.slice(8));
    expect(hash).toBe(hashApiKey(key, 'p'.repeat(32)));
    expect(hash).not.toBe(hashApiKey(key, 'q'.repeat(32)));
  });

  it('compares hashes in constant time and rejects malformed input', () => {
    const h = hashApiKey('sk_test_x', 'p'.repeat(32));
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, hashApiKey('sk_test_y', 'p'.repeat(32)))).toBe(false);
    expect(hashesEqual(h, h.slice(2))).toBe(false);
    expect(hashesEqual('', '')).toBe(false);
    expect(looksLikeApiKey('sk_live_' + 'a'.repeat(43))).toBe(false);
  });
});

describe('config', () => {
  it('refuses mainnet', () => {
    expect(() => testConfig({ NETWORK_PASSPHRASE: PUBNET_PASSPHRASE })).toThrow(ConfigError);
  });

  it('refuses insecure webhooks in production', () => {
    expect(() => testConfig({ NODE_ENV: 'production', WEBHOOK_ALLOW_INSECURE: 'true' })).toThrow(ConfigError);
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ DATABASE_URL: 'x', OPERATOR_SECRET: 'SNOTAREALSECRETVALUE', API_KEY_PEPPER: 'short' });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const text = JSON.stringify((e as ConfigError).issues) + (e as Error).message;
      expect(text).not.toContain('SNOTAREALSECRETVALUE');
      expect(text).not.toContain('short');
    }
  });
});

describe('payment state machine', () => {
  it('only allows forward contract edges', () => {
    expect(canTransition('created', 'paid')).toBe(true);
    expect(canTransition('paid', 'created')).toBe(false);
    expect(canTransition('settled', 'refunded')).toBe(false);
    expect(canTransition('cancelled', 'paid')).toBe(false);
    expect(canTransition('created', 'refunded')).toBe(false);
    expect(canTransition('pending', 'settled')).toBe(true);
  });

  it('emits events for skipped intermediate states', () => {
    expect(eventsForTransition('created', 'settled')).toEqual(['payment.paid', 'payment.settled']);
    expect(eventsForTransition('pending', 'paid')).toEqual(['payment.created', 'payment.paid']);
    expect(eventsForTransition('paid', 'refunded')).toEqual(['payment.refunded']);
    expect(eventsForTransition('pending', 'cancelled')).toEqual(['payment.created', 'payment.cancelled']);
    expect(eventsForTransition('settled', 'paid')).toEqual([]);
  });
});

describe('webhook signatures', () => {
  // Fixed vector: anyone re-implementing verification can check against this.
  const secret = 'whsec_test_vector';
  const body = '{"id":"evt_1","type":"payment.paid"}';
  const t = 1_700_000_000;
  it('matches the documented HMAC-SHA256(secret, t + "." + body) vector', () => {
    expect(computeSignature(secret, t, body)).toBe('676f6f83fa80606ab3bfab0a2b8fdfcba947d2959619c4dfabcf36b0ebe72b32');
    expect(signatureHeader(secret, t, body)).toBe('t=1700000000,v1=676f6f83fa80606ab3bfab0a2b8fdfcba947d2959619c4dfabcf36b0ebe72b32');
  });

  it('verifies, and rejects tampering, wrong secrets and stale timestamps', () => {
    const header = signatureHeader(secret, t, body);
    expect(verifySignatureHeader(header, body, secret, { now: t })).toBe(true);
    expect(verifySignatureHeader(header, body + ' ', secret, { now: t })).toBe(false);
    expect(verifySignatureHeader(header, body, 'other', { now: t })).toBe(false);
    expect(verifySignatureHeader(header, body, secret, { now: t + 301 })).toBe(false);
    expect(verifySignatureHeader('garbage', body, secret, { now: t })).toBe(false);
  });

  it('encrypts secrets at rest with authenticated encryption', () => {
    const key = 'cd'.repeat(32);
    const enc = encryptSecret('whsec_abc', key);
    expect(enc).not.toContain('whsec_abc');
    expect(decryptSecret(enc, key)).toBe('whsec_abc');
    expect(encryptSecret('whsec_abc', key)).not.toBe(enc); // random IV
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, 'ef'.repeat(32))).toThrow();
  });
});

describe('retry schedule', () => {
  it('backs off exponentially with jitter over about a day, 8 attempts total', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    const mid = RETRY_DELAYS_SEC.map((_, i) => nextAttemptDelayMs(i + 1, () => 0.5) / 1000);
    expect(mid).toEqual([...RETRY_DELAYS_SEC]);
    for (let i = 1; i < mid.length; i++) expect(mid[i]).toBeGreaterThan(mid[i - 1] as number);
    const total = RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    expect(total / 3600).toBeGreaterThan(20);
    expect(total / 3600).toBeLessThan(26);
    expect(nextAttemptDelayMs(1, () => 0)).toBe(24_000);
    expect(nextAttemptDelayMs(1, () => 1)).toBe(36_000);
  });
});

describe('SSRF protection', () => {
  const strict = { allowInsecure: false };
  it.each([
    ['127.0.0.1'], ['10.1.2.3'], ['172.16.0.1'], ['172.31.255.255'], ['192.168.1.1'], ['169.254.169.254'],
    ['100.64.0.1'], ['0.0.0.0'], ['224.0.0.1'], ['::1'], ['fe80::1'], ['fd00::1'], ['::ffff:127.0.0.1'], ['::ffff:10.0.0.1'], ['not-an-ip'],
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([['93.184.216.34'], ['8.8.8.8'], ['2606:4700:4700::1111'], ['172.32.0.1']])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('requires https and rejects credentials', () => {
    expect(() => parseWebhookUrl('http://example.com/hook', strict)).toThrow();
    expect(() => parseWebhookUrl('https://user:pw@example.com/hook', strict)).toThrow();
    expect(() => parseWebhookUrl('ftp://example.com', strict)).toThrow();
    expect(parseWebhookUrl('https://example.com/hook', strict).hostname).toBe('example.com');
    expect(parseWebhookUrl('http://localhost:9999/x', { allowInsecure: true }).protocol).toBe('http:');
  });

  it('rejects hosts that resolve to private addresses (any record)', async () => {
    const url = new URL('https://rebind.example/hook');
    await expect(resolveSafeTarget(url, strict, async () => [{ address: '10.0.0.5', family: 4 }])).rejects.toThrow();
    await expect(
      resolveSafeTarget(url, strict, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow();
    await expect(resolveSafeTarget(new URL('https://169.254.169.254/latest'), strict)).rejects.toThrow();
    await expect(resolveSafeTarget(new URL('https://localhost/x'), strict)).rejects.toThrow();
    await expect(resolveSafeTarget(new URL('https://[::1]/x'), strict)).rejects.toThrow();
    await expect(resolveSafeTarget(url, strict, async () => [{ address: '93.184.216.34', family: 4 }])).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('allows loopback (only) in insecure dev mode', async () => {
    const dev = { allowInsecure: true };
    await expect(resolveSafeTarget(new URL('http://127.0.0.1:8080/x'), dev)).resolves.toMatchObject({ address: '127.0.0.1' });
    await expect(resolveSafeTarget(new URL('http://10.0.0.1/x'), dev)).rejects.toThrow();
  });
});
