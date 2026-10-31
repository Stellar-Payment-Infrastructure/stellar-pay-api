import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, PublicClient, StellarPay, StellarPayError, StellarPayNetworkError, toBigInt } from '../src/index.js';
import type { FetchLike, Payment } from '../src/index.js';
import { computeSignature, sign, verify, WebhookVerificationError, webhooks } from '../src/webhooks.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A tiny scripted mock server: route handlers keyed by "METHOD /path". */
function mockFetch(routes: Record<string, (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${u.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }), { status: 404 });
    const r = handler(call);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  };
  return { fetch, calls };
}

const payment = (over: Partial<Payment> = {}): Payment =>
  ({ id: 'a'.repeat(64), object: 'payment', status: 'created', amount: '100', ...over }) as Payment;

describe('StellarPay client', () => {
  it('sends the bearer key, JSON body and an automatic Idempotency-Key on create', async () => {
    const m = mockFetch({ 'POST /v1/payments': (c) => ({ status: 201, body: payment({ amount: (c.body as { amount: string }).amount }) }) });
    const sp = new StellarPay({ apiKey: 'sk_test_x', baseUrl: 'https://api.example/', fetch: m.fetch });
    const p = await sp.payments.create({ amount: 12_345_678_901_234_567_890n, reference: 'r1' });
    expect(p.amount).toBe('12345678901234567890');
    const call = m.calls[0] as Call;
    expect(call.url).toBe('https://api.example/v1/payments');
    expect(call.headers['authorization']).toBe('Bearer sk_test_x');
    expect(call.headers['idempotency-key']).toMatch(/.{8,}/);
    expect(call.body).toEqual({ amount: '12345678901234567890', reference: 'r1' });
    await sp.payments.create({ amount: '5' }, { idempotencyKey: 'mine' });
    expect(m.calls[1]?.headers['idempotency-key']).toBe('mine');
  });

  it('maps the error envelope to StellarPayError', async () => {
    const m = mockFetch({
      'POST /v1/payments/x/settle': () => ({
        status: 409,
        body: { error: { code: 'INVALID_PAYMENT_STATE', message: 'nope', details: { status: 'created' } } },
        headers: { 'x-request-id': 'req-1' },
      }),
    });
    const sp = new StellarPay({ apiKey: 'k', baseUrl: 'https://api.example', fetch: m.fetch });
    const err = (await sp.payments.settle('x').catch((e: unknown) => e)) as StellarPayError;
    expect(err).toBeInstanceOf(StellarPayError);
    expect(err).toMatchObject({ code: 'INVALID_PAYMENT_STATE', status: 409, details: { status: 'created' }, requestId: 'req-1' });
    const plain = mockFetch({ 'GET /v1/merchant': () => ({ status: 502, body: 'gateway' }) });
    const e2 = (await new StellarPay({ apiKey: 'k', baseUrl: 'https://a', fetch: plain.fetch }).merchant().catch((e: unknown) => e)) as StellarPayError;
    expect(e2.code).toBe('HTTP_502');
  });

  it('wraps network failures and timeouts', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const sp = new StellarPay({ apiKey: 'k', baseUrl: 'https://a', fetch: failing });
    await expect(sp.payments.get('x')).rejects.toBeInstanceOf(StellarPayNetworkError);
    const hanging: FetchLike = (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const slow = new StellarPay({ apiKey: 'k', baseUrl: 'https://a', fetch: hanging, timeoutMs: 10 });
    await expect(slow.payments.get('x')).rejects.toThrow('timed out');
  });

  it('calls the global fetch unbound (browsers throw "Illegal invocation" otherwise)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return new Response(JSON.stringify({ id: 'p' }), { status: 200 });
    } as typeof fetch;
    try {
      await expect(new PublicClient('https://a').getPayment('p')).resolves.toEqual({ id: 'p' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('listAll follows cursors until hasMore is false', async () => {
    const pages: Record<string, { data: Payment[]; hasMore: boolean; nextCursor: string | null }> = {
      '': { data: [payment({ id: '1' }), payment({ id: '2' })], hasMore: true, nextCursor: 'c1' },
      c1: { data: [payment({ id: '3' })], hasMore: true, nextCursor: 'c2' },
      c2: { data: [payment({ id: '4' })], hasMore: false, nextCursor: null },
    };
    const m = mockFetch({ 'GET /v1/payments': (c) => ({ body: pages[new URL(c.url).searchParams.get('cursor') ?? ''] }) });
    const sp = new StellarPay({ apiKey: 'k', baseUrl: 'https://a', fetch: m.fetch });
    const ids: string[] = [];
    for await (const p of sp.payments.listAll({ status: 'settled', limit: 2 })) ids.push(p.id);
    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(new URL(m.calls[0]!.url).searchParams.get('status')).toBe('settled');
  });

  it('covers webhook endpoints, deliveries and API keys', async () => {
    const m = mockFetch({
      'POST /v1/webhook-endpoints': () => ({ status: 201, body: { id: 'e1', secret: 'whsec_1' } }),
      'GET /v1/webhook-endpoints': () => ({ body: { data: [{ id: 'e1' }] } }),
      'PATCH /v1/webhook-endpoints/e1': (c) => ({ body: { id: 'e1', ...(c.body as object) } }),
      'DELETE /v1/webhook-endpoints/e1': () => ({ status: 204 }),
      'GET /v1/webhook-deliveries': () => ({ body: { data: [{ id: 'd1' }] } }),
      'POST /v1/webhook-deliveries/d1/retry': () => ({ body: { id: 'd1', status: 'pending' } }),
      'POST /v1/api-keys': () => ({ status: 201, body: { id: 'k2', key: 'sk_test_new' } }),
      'GET /v1/api-keys': () => ({ body: { data: [] } }),
      'DELETE /v1/api-keys/k2': () => ({ status: 204 }),
    });
    const sp = new StellarPay({ apiKey: 'k', baseUrl: 'https://a', fetch: m.fetch });
    expect((await sp.webhookEndpoints.create({ url: 'https://m.example/h' })).secret).toBe('whsec_1');
    expect(await sp.webhookEndpoints.list()).toHaveLength(1);
    expect((await sp.webhookEndpoints.update('e1', { enabled: false })).enabled).toBe(false);
    await expect(sp.webhookEndpoints.delete('e1')).resolves.toBeUndefined();
    expect(await sp.webhookDeliveries.list({ status: 'failed' })).toHaveLength(1);
    expect((await sp.webhookDeliveries.retry('d1')).status).toBe('pending');
    expect((await sp.apiKeys.create(['payments:read'])).key).toBe('sk_test_new');
    expect(await sp.apiKeys.list()).toEqual([]);
    await sp.apiKeys.revoke('k2');
    expect(m.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toContain('DELETE /v1/api-keys/k2');
  });

  it('refuses to be constructed in a browser or without a key', () => {
    expect(() => new StellarPay({ apiKey: '', baseUrl: 'https://a' })).toThrow('apiKey');
    const g = globalThis as Record<string, unknown>;
    g['window'] = {};
    g['document'] = {};
    try {
      expect(() => new StellarPay({ apiKey: 'k', baseUrl: 'https://a' })).toThrow('browser');
    } finally {
      delete g['window'];
      delete g['document'];
    }
  });
});

describe('PublicClient', () => {
  it('calls the public checkout endpoints without any key', async () => {
    const m = mockFetch({
      [`GET /v1/public/payments/${'a'.repeat(64)}`]: () => ({ body: { id: 'a'.repeat(64), status: 'created' } }),
      [`POST /v1/public/payments/${'a'.repeat(64)}/transaction`]: () => ({ body: { transactionXdr: 'AAA', networkPassphrase: 'Test', validUntil: 'x' } }),
      [`POST /v1/public/payments/${'a'.repeat(64)}/submit`]: () => ({ body: { transactionHash: 'h', status: 'paid' } }),
    });
    const pc = new PublicClient({ baseUrl: 'https://a', fetch: m.fetch });
    const id = 'a'.repeat(64);
    expect((await pc.getPayment(id)).status).toBe('created');
    expect((await pc.buildTransaction(id, 'GPAYER')).transactionXdr).toBe('AAA');
    expect((await pc.submitTransaction(id, 'SIGNED')).status).toBe('paid');
    expect(m.calls.every((c) => !('authorization' in c.headers))).toBe(true);
    expect(m.calls[1]?.body).toEqual({ payer: 'GPAYER' });
    expect(m.calls[2]?.body).toEqual({ signedXdr: 'SIGNED' });
  });
});

describe('webhooks.verify', () => {
  const secret = 'whsec_test_vector';
  const body = '{"id":"evt_1","type":"payment.paid"}';
  const t = 1_700_000_000;

  it('matches the API signature vector', () => {
    expect(computeSignature(secret, t, body)).toBe('676f6f83fa80606ab3bfab0a2b8fdfcba947d2959619c4dfabcf36b0ebe72b32');
  });

  it('returns the parsed event for a valid signature (string or Buffer body)', () => {
    const header = sign(secret, body, t);
    expect(verify(body, header, secret, { now: t }).id).toBe('evt_1');
    expect(webhooks.verify(Buffer.from(body), [header], secret, { now: t + 10 }).type).toBe('payment.paid');
  });

  it('rejects tampering, wrong secrets, stale timestamps and junk headers', () => {
    const header = sign(secret, body, t);
    const bad = (fn: () => unknown, msg: string) => expect(fn).toThrowError(new WebhookVerificationError(msg));
    bad(() => verify(`${body} `, header, secret, { now: t }), 'signature mismatch');
    bad(() => verify(body, header, 'other', { now: t }), 'signature mismatch');
    bad(() => verify(body, header, secret, { now: t + 301 }), 'timestamp outside tolerance');
    bad(() => verify(body, undefined, secret), 'missing signature header');
    bad(() => verify(body, 'v1=abc', secret), 'malformed signature header');
    bad(() => verify(body, `t=${t},v1=zz`, secret, { now: t }), 'signature mismatch');
  });

  it('accepts any of multiple v1 signatures (secret rotation)', () => {
    const good = computeSignature(secret, t, body);
    expect(verify(body, `t=${t},v1=${'0'.repeat(64)},v1=${good}`, secret, { now: t }).id).toBe('evt_1');
  });
});

describe('amount helpers (no floats)', () => {
  it.each([
    [12_345_678n, 7, '1.2345678'],
    [10_000_000n, 7, '1'],
    [1n, 7, '0.0000001'],
    [0n, 7, '0'],
    [-15n, 1, '-1.5'],
    ['340282366920938463463374607431768211455', 7, '34028236692093846346337460743176.8211455'],
    [5n, 0, '5'],
  ] as const)('formatAmount(%s, %i) = %s', (v, d, want) => {
    expect(formatAmount(v, d)).toBe(want);
  });

  it('pads to minFractionDigits', () => {
    expect(formatAmount(50_000_000n, 7, { minFractionDigits: 2 })).toBe('5.00');
    expect(formatAmount(51_234_000n, 7, { minFractionDigits: 2 })).toBe('5.1234');
  });

  it('parses decimals exactly and refuses extra precision', () => {
    expect(parseAmount('1.5', 7)).toBe(15_000_000n);
    expect(parseAmount('0.0000001', 7)).toBe(1n);
    expect(parseAmount('.5', 1)).toBe(5n);
    expect(parseAmount('123', 0)).toBe(123n);
    expect(() => parseAmount('0.00000001', 7)).toThrow(RangeError);
    for (const junk of ['', '.', 'abc', '1e5', '1,5', '1.2.3']) expect(() => parseAmount(junk, 7)).toThrow();
    expect(() => toBigInt('1.5')).toThrow(TypeError);
    // Round trip at the i128 boundary.
    const max = 2n ** 127n - 1n;
    expect(parseAmount(formatAmount(max, 7), 7)).toBe(max);
  });
});

describe('contract: SDK matches the committed OpenAPI spec', () => {
  it('src/generated/openapi.ts is what openapi-typescript produces from openapi.json', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'sp-sdk-')), 'openapi.ts');
    const bin = path.join(root, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
    execFileSync(process.execPath, [bin, path.join(root, 'openapi.json'), '-o', out], { stdio: 'pipe' });
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    expect(norm(readFileSync(path.join(root, 'src', 'generated', 'openapi.ts'), 'utf8'))).toBe(norm(readFileSync(out, 'utf8')));
  });
});
