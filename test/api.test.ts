import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo.js';
import { apiKeys } from '../src/db/schema.js';
import { ChainTimeoutError, SubmitError } from '../src/errors.js';
import { buildPayTx, createHarness, type Harness, idem, seedMerchant } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function createPayment(auth: { Authorization: string }, body: Record<string, unknown> = { amount: '1000000' }) {
  const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; status: string; amount: string };
}

describe('health and docs', () => {
  it('serves health, OpenAPI and Swagger UI without a key', async () => {
    expect((await request(h.app).get('/v1/health')).body).toMatchObject({ status: 'ok', network: 'testnet' });
    const spec = await request(h.app).get('/v1/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/v1/public/payments/{id}/submit');
    expect((await request(h.app).get('/docs/')).status).toBe(200);
  });

  it('sets security headers and returns the error envelope for unknown routes', async () => {
    const res = await request(h.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects oversized and malformed bodies cleanly', async () => {
    const { auth } = await seedMerchant(h.db);
    const big = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '1', reference: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const bad = await request(h.app).post('/v1/payments').set(auth).set(idem()).set('content-type', 'application/json').send('{"amount":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });
});

describe('authentication', () => {
  it('rejects missing, malformed, unknown and revoked keys', async () => {
    const { key, merchant } = await seedMerchant(h.db);
    expect((await request(h.app).get('/v1/payments')).status).toBe(401);
    expect((await request(h.app).get('/v1/payments').set('Authorization', 'Bearer nope')).status).toBe(401);
    const forged = `sk_test_${randomBytes(32).toString('base64url')}`;
    expect((await request(h.app).get('/v1/payments').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    // Same visible prefix, different secret.
    const samePrefix = key.slice(0, 16) + 'A'.repeat(key.length - 16);
    expect((await request(h.app).get('/v1/payments').set('Authorization', `Bearer ${samePrefix}`)).status).toBe(401);
    expect((await request(h.app).get('/v1/payments').set('Authorization', `Bearer ${key}`)).status).toBe(200);
    const [row] = await repo.listApiKeys(h.db, merchant.id);
    await repo.revokeApiKey(h.db, merchant.id, row!.id);
    expect((await request(h.app).get('/v1/payments').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  });

  it('stores only a hash of the key', async () => {
    const { key } = await seedMerchant(h.db);
    const rows = await h.db.select().from(apiKeys);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key.slice(16));
  });

  it('enforces scopes and prevents scope escalation when minting keys', async () => {
    const { auth } = await seedMerchant(h.db, { scopes: ['payments:read'] });
    const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '1' });
    expect(res.status).toBe(403);
    expect((await request(h.app).get('/v1/payments').set(auth)).status).toBe(200);
    expect((await request(h.app).post('/v1/api-keys').set(auth).send({ scopes: ['payments:write'] })).status).toBe(403);
    const ok = await request(h.app).post('/v1/api-keys').set(auth).send({ scopes: ['payments:read'] });
    expect(ok.status).toBe(201);
    expect(ok.body.key).toMatch(/^sk_test_/);
    const list = await request(h.app).get('/v1/api-keys').set(auth);
    expect(JSON.stringify(list.body)).not.toContain(ok.body.key);
  });

  it('isolates merchants from each other', async () => {
    const a = await seedMerchant(h.db);
    const b = await seedMerchant(h.db);
    const p = await createPayment(a.auth);
    expect((await request(h.app).get(`/v1/payments/${p.id}`).set(b.auth)).status).toBe(404);
    expect((await request(h.app).post(`/v1/payments/${p.id}/cancel`).set(b.auth)).status).toBe(404);
    expect((await request(h.app).get('/v1/payments').set(b.auth)).body.data).toHaveLength(0);
  });
});

describe('POST /v1/payments', () => {
  it('creates the payment on-chain and returns the resource', async () => {
    const { auth, merchant } = await seedMerchant(h.db);
    const p = await createPayment(auth, { amount: '9223372036854775807', reference: 'order-42', metadata: { sku: 'A1' }, settleMode: 'auto' });
    expect(p).toMatchObject({ status: 'created', amount: '9223372036854775807', settleMode: 'auto', reference: 'order-42', merchantId: merchant.id });
    expect(p.id).toMatch(/^[0-9a-f]{64}$/);
    const onChain = h.chain.payments.get(p.id);
    expect(onChain?.amount).toBe(9223372036854775807n);
    expect(onChain?.merchant).toBe(merchant.payoutAddress);
    // Only a salted hash of the reference goes on-chain.
    expect(onChain?.reference).not.toContain(Buffer.from('order-42').toString('hex'));
    const events = await repo.listPaymentEvents(h.db, p.id);
    expect(events.map((e) => e.type)).toEqual(['payment.created']);
  });

  it('validates amounts as positive integer strings within limits', async () => {
    const { auth } = await seedMerchant(h.db);
    for (const amount of ['0', '-1', '1.5', '1e6', ' 1', '01', 100, '']) {
      const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount });
      expect(res.status, String(amount)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const tooBig = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '9223372036854775808' });
    expect(tooBig.body.error.code).toBe('INVALID_AMOUNT');
    const otherToken = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '1', token: 'CXXX' });
    expect(otherToken.body.error.code).toBe('TOKEN_NOT_ALLOWED');
    const unknownField = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '1', merchant: 'G...' });
    expect(unknownField.status).toBe(400);
  });

  it('requires an Idempotency-Key and replays the original response', async () => {
    const { auth } = await seedMerchant(h.db);
    expect((await request(h.app).post('/v1/payments').set(auth).send({ amount: '5' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = { 'Idempotency-Key': 'order-1-attempt' };
    const first = await request(h.app).post('/v1/payments').set(auth).set(key).send({ amount: '5' });
    const second = await request(h.app).post('/v1/payments').set(auth).set(key).send({ amount: '5' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.chain.calls.filter((c) => c === 'create_payment')).toHaveLength(1);
    const reused = await request(h.app).post('/v1/payments').set(auth).set(key).send({ amount: '6' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Keys are per merchant.
    const other = await seedMerchant(h.db);
    expect((await request(h.app).post('/v1/payments').set(other.auth).set(key).send({ amount: '5' })).status).toBe(201);
  });

  it('persists nothing when the chain call definitively fails, and frees the idempotency key', async () => {
    const { auth, merchant } = await seedMerchant(h.db);
    h.chain.failNext = new SubmitError('Transaction failed on-chain');
    const key = { 'Idempotency-Key': 'retry-me' };
    const res = await request(h.app).post('/v1/payments').set(auth).set(key).send({ amount: '5' });
    expect(res.status).toBe(502);
    expect(await repo.listPayments(h.db, { merchantId: merchant.id, limit: 10 })).toHaveLength(0);
    const retry = await request(h.app).post('/v1/payments').set(auth).set(key).send({ amount: '5' });
    expect(retry.status).toBe(201);
  });

  it('keeps the payment pending (202) when the chain outcome is unknown', async () => {
    const { auth } = await seedMerchant(h.db);
    h.chain.failNext = new ChainTimeoutError('ab'.repeat(32));
    const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '5' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.transactions.create).toBe('ab'.repeat(32));
  });

  it('maps contract errors to stable codes', async () => {
    const { auth } = await seedMerchant(h.db);
    const { SimulationError } = await import('../src/errors.js');
    h.chain.failNext = new SimulationError(8, 'HostError: Error(Contract, #8)');
    const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '5' });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'CONTRACT_PAUSED', message: 'Transaction simulation failed', details: { contractError: 8 } });
  });
});

describe('GET /v1/payments', () => {
  it('paginates with a cursor, filters by status and supports updated_since', async () => {
    const { auth } = await seedMerchant(h.db);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) created.push((await createPayment(auth, { amount: String(i + 1) })).id);
    await request(h.app).post(`/v1/payments/${created[0]}/cancel`).set(auth);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(h.app).get('/v1/payments').query({ limit: 3, ...(cursor ? { cursor } : {}) }).set(auth);
      expect(res.status).toBe(200);
      seen.push(...(res.body.data as { id: string }[]).map((p) => p.id));
      cursor = res.body.nextCursor as string | null;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set(created));
    expect(seen).toHaveLength(7);

    const cancelled = await request(h.app).get('/v1/payments').query({ status: 'cancelled' }).set(auth);
    expect(cancelled.body.data.map((p: { id: string }) => p.id)).toEqual([created[0]]);

    const feed = await request(h.app).get('/v1/payments').query({ updated_since: '2000-01-01T00:00:00Z', limit: 100 }).set(auth);
    const times = (feed.body.data as { updatedAt: string }[]).map((p) => p.updatedAt);
    expect([...times].sort()).toEqual(times);
    expect((await request(h.app).get('/v1/payments').query({ cursor: '!!' }).set(auth)).body.error.code).toBe('INVALID_CURSOR');
    expect((await request(h.app).get('/v1/payments').query({ limit: 1000 }).set(auth)).status).toBe(400);
  });

  it('returns 404 for malformed and unknown ids', async () => {
    const { auth } = await seedMerchant(h.db);
    expect((await request(h.app).get('/v1/payments/xyz').set(auth)).status).toBe(404);
    expect((await request(h.app).get(`/v1/payments/${'0'.repeat(64)}`).set(auth)).status).toBe(404);
    expect((await request(h.app).get("/v1/payments/' OR 1=1 --").set(auth)).status).toBe(404);
  });
});

describe('operator actions', () => {
  it('settles, refunds and cancels through the contract, enforcing state', async () => {
    const { auth } = await seedMerchant(h.db);
    const a = await createPayment(auth);
    expect((await request(h.app).post(`/v1/payments/${a.id}/settle`).set(auth)).body.error.code).toBe('INVALID_PAYMENT_STATE');
    h.chain.pay(a.id, Keypair.random().publicKey());
    await repo.updatePayment(h.db, a.id, { status: 'paid', feeBps: 100 });
    const settled = await request(h.app).post(`/v1/payments/${a.id}/settle`).set(auth);
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ status: 'settled', fee: '10000' });
    expect(settled.body.transactions.settle).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(h.app).post(`/v1/payments/${a.id}/refund`).set(auth)).status).toBe(409);

    const b = await createPayment(auth);
    h.chain.pay(b.id, Keypair.random().publicKey());
    await repo.updatePayment(h.db, b.id, { status: 'paid' });
    expect((await request(h.app).post(`/v1/payments/${b.id}/refund`).set(auth)).body.status).toBe('refunded');

    const c = await createPayment(auth);
    expect((await request(h.app).post(`/v1/payments/${c.id}/cancel`).set(auth)).body.status).toBe('cancelled');
    expect((await request(h.app).post(`/v1/payments/${c.id}/cancel`).set(auth)).status).toBe(409);
  });

  it('surfaces a stale DB as a contract error instead of corrupting state', async () => {
    const { auth } = await seedMerchant(h.db);
    const a = await createPayment(auth);
    // DB thinks it is paid, chain says created.
    await repo.updatePayment(h.db, a.id, { status: 'paid' });
    const res = await request(h.app).post(`/v1/payments/${a.id}/settle`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_PAYMENT_STATE');
    expect((await repo.findPayment(h.db, a.id))?.status).toBe('paid');
  });
});

describe('public checkout', () => {
  it('returns only the minimal view, without a key, with CORS for checkout origins', async () => {
    const { auth } = await seedMerchant(h.db);
    const p = await createPayment(auth, { amount: '10', reference: 'secret-order', metadata: { email: 'x@y.z' } });
    const res = await request(h.app).get(`/v1/public/payments/${p.id}`).set('Origin', 'https://checkout.example');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['amount', 'cancelUrl', 'createdAt', 'decimals', 'id', 'merchantName', 'status', 'successUrl', 'token', 'tokenCode', 'updatedAt'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain('secret-order');
    expect(JSON.stringify(res.body)).not.toContain('x@y.z');
    expect(res.headers['access-control-allow-origin']).toBe('https://checkout.example');
    const evil = await request(h.app).get(`/v1/public/payments/${p.id}`).set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    // The merchant API never sends CORS headers.
    const merchantApi = await request(h.app).get('/v1/payments').set(auth).set('Origin', 'https://checkout.example');
    expect(merchantApi.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('builds, verifies and submits the pay transaction end-to-end', async () => {
    const { auth } = await seedMerchant(h.db);
    const p = await createPayment(auth, { amount: '1000' });
    const payer = Keypair.random();
    const built = await request(h.app).post(`/v1/public/payments/${p.id}/transaction`).send({ payer: payer.publicKey() });
    expect(built.status).toBe(200);
    expect(built.body.networkPassphrase).toBe('Test SDF Network ; September 2015');
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(built.body.transactionXdr as string, built.body.networkPassphrase as string);
    tx.sign(payer);
    const submitted = await request(h.app).post(`/v1/public/payments/${p.id}/submit`).send({ signedXdr: tx.toXDR() });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.status).toBe('paid');
    const row = await repo.findPayment(h.db, p.id);
    expect(row).toMatchObject({ status: 'paid', payer: payer.publicKey(), feeBps: 100 });
    // A second submission is refused: no longer payable.
    expect((await request(h.app).post(`/v1/public/payments/${p.id}/submit`).send({ signedXdr: tx.toXDR() })).status).toBe(409);
  });

  it('never relays a transaction that is not exactly our pay for this payment', async () => {
    const { auth } = await seedMerchant(h.db);
    const p = await createPayment(auth);
    const other = await createPayment(auth);
    const payer = Keypair.random();
    const cases = [
      buildPayTx({ payer: payer.publicKey(), paymentId: other.id }),
      buildPayTx({ payer: payer.publicKey(), paymentId: p.id, fn: 'settle' }),
      buildPayTx({ payer: payer.publicKey(), paymentId: p.id, extraOps: 2 }),
      buildPayTx({ payer: payer.publicKey(), paymentId: p.id, fee: '999999999' }),
    ];
    for (const tx of cases) {
      tx.sign(payer);
      const res = await request(h.app).post(`/v1/public/payments/${p.id}/submit`).send({ signedXdr: tx.toXDR() });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TRANSACTION');
    }
    expect(h.chain.calls).not.toContain('submit');
  });

  it('refuses to build a pay transaction when the on-chain record is not ours', async () => {
    const { auth } = await seedMerchant(h.db);
    const p = await createPayment(auth, { amount: '1000' });
    // Simulate a mismatch: the on-chain merchant differs from our record.
    h.chain.payments.get(p.id)!.merchant = Keypair.random().publicKey();
    const res = await request(h.app).post(`/v1/public/payments/${p.id}/transaction`).send({ payer: Keypair.random().publicKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_STATE_MISMATCH');
    expect(h.chain.calls).not.toContain('build_pay');
  });

  it('validates payers and payable state', async () => {
    const { auth } = await seedMerchant(h.db);
    const p = await createPayment(auth);
    expect((await request(h.app).post(`/v1/public/payments/${p.id}/transaction`).send({ payer: 'C'.repeat(56) })).body.error.code).toBe('INVALID_PAYER');
    await request(h.app).post(`/v1/payments/${p.id}/cancel`).set(auth);
    const res = await request(h.app).post(`/v1/public/payments/${p.id}/transaction`).send({ payer: Keypair.random().publicKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_PAYABLE');
    expect((await request(h.app).get(`/v1/public/payments/${'f'.repeat(64)}`)).status).toBe(404);
  });

  it('rate-limits public routes per IP', async () => {
    const limited = await createHarness({ PUBLIC_RATE_LIMIT_PER_MIN: '3' });
    try {
      const url = `/v1/public/payments/${'f'.repeat(64)}`;
      for (let i = 0; i < 3; i++) expect((await request(limited.app).get(url)).status).toBe(404);
      const res = await request(limited.app).get(url);
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeTruthy();
    } finally {
      await limited.close();
    }
  });
});

describe('webhook endpoints', () => {
  it('creates (secret shown once, encrypted at rest), lists, updates and deletes', async () => {
    const { auth } = await seedMerchant(h.db);
    const created = await request(h.app).post('/v1/webhook-endpoints').set(auth).send({ url: 'https://merchant.example/hook' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.events).toHaveLength(5);
    const row = await repo.findWebhookEndpointById(h.db, created.body.id as string);
    expect(row?.secretEnc).toMatch(/^v1\./);
    expect(row?.secretEnc).not.toContain(created.body.secret);
    const list = await request(h.app).get('/v1/webhook-endpoints').set(auth);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    const upd = await request(h.app).patch(`/v1/webhook-endpoints/${created.body.id}`).set(auth).send({ enabled: false, events: ['payment.paid'] });
    expect(upd.body).toMatchObject({ enabled: false, events: ['payment.paid'] });
    expect((await request(h.app).delete(`/v1/webhook-endpoints/${created.body.id}`).set(auth)).status).toBe(204);
    expect((await request(h.app).get(`/v1/webhook-endpoints/${created.body.id}`).set(auth)).status).toBe(404);
  });

  it('rejects non-HTTPS and private targets', async () => {
    const strict = await createHarness({ WEBHOOK_ALLOW_INSECURE: 'false' });
    try {
      const { auth } = await seedMerchant(strict.db);
      for (const url of ['http://merchant.example/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://localhost/x']) {
        const res = await request(strict.app).post('/v1/webhook-endpoints').set(auth).send({ url });
        expect(res.status, url).toBe(400);
        expect(res.body.error.code, url).toBe('INVALID_WEBHOOK_URL');
      }
      const badEvent = await request(strict.app).post('/v1/webhook-endpoints').set(auth).send({ url: 'https://merchant.example/x', events: ['payment.stolen'] });
      expect(badEvent.status).toBe(400);
    } finally {
      await strict.close();
    }
  });
});
