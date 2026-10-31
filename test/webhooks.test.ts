import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo.js';
import { webhookDeliveries } from '../src/db/schema.js';
import { runIndexerBatch } from '../src/indexer/indexer.js';
import { verifySignatureHeader } from '../src/webhooks/crypto.js';
import { MAX_ATTEMPTS, runDispatcherBatch } from '../src/webhooks/dispatcher.js';
import { createSender } from '../src/webhooks/http.js';
import { createHarness, type Harness, idem, seedMerchant } from './helpers.js';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let h: Harness;
let server: http.Server;
let received: Received[];
let respondWith: number;
let port: number;

beforeEach(async () => {
  h = await createHarness();
  received = [];
  respondWith = 200;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      if (respondWith >= 300 && respondWith < 400) res.setHeader('location', 'http://169.254.169.254/');
      res.statusCode = respondWith;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await h.close();
});

const sender = () => createSender({ policy: { allowInsecure: true }, timeoutMs: 2_000 });

async function endpointAndPayment() {
  const m = await seedMerchant(h.db);
  const ep = await request(h.app).post('/v1/webhook-endpoints').set(m.auth).send({ url: `http://127.0.0.1:${port}/hooks` });
  expect(ep.status).toBe(201);
  const p = await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '4200', reference: 'o-1' });
  return { m, secret: ep.body.secret as string, endpointId: ep.body.id as string, paymentId: p.body.id as string };
}

describe('webhook dispatcher (local receiver)', () => {
  it('delivers signed, verifiable events with a stable id', async () => {
    const { secret, paymentId } = await endpointAndPayment();
    const n = await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: sender() });
    expect(n).toBe(1);
    expect(received).toHaveLength(1);
    const r = received[0] as Received;
    const sig = r.headers['stellar-pay-signature'] as string;
    expect(verifySignatureHeader(sig, r.body, secret)).toBe(true);
    const evt = JSON.parse(r.body) as { id: string; type: string; data: { payment: { id: string; amount: string } } };
    expect(evt.type).toBe('payment.created');
    expect(evt.id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(r.headers['stellar-pay-event-id']).toBe(evt.id);
    expect(evt.data.payment).toMatchObject({ id: paymentId, amount: '4200' });
    const [d] = await h.db.select().from(webhookDeliveries);
    expect(d).toMatchObject({ status: 'succeeded', attempt: 1, responseCode: 200 });
  });

  it('retries with backoff on failure, then dead-letters after the max attempts', async () => {
    await endpointAndPayment();
    respondWith = 500;
    let now = new Date();
    const step = async () => {
      await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: sender(), now: () => now, random: () => 0.5 });
      const [d] = await h.db.select().from(webhookDeliveries);
      return d as repo.WebhookDeliveryRow;
    };
    let d = await step();
    expect(d).toMatchObject({ status: 'pending', attempt: 1, responseCode: 500 });
    expect(d.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);
    // Not due yet: nothing is sent.
    await step();
    expect(received).toHaveLength(1);
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      now = new Date(d.nextAttemptAt.getTime() + 1);
      d = await step();
    }
    expect(received).toHaveLength(MAX_ATTEMPTS);
    expect(d).toMatchObject({ status: 'failed', attempt: MAX_ATTEMPTS });
    // Manual retry re-queues it.
    const m = (await repo.findWebhookEndpointById(h.db, d.endpointId))!.merchantId;
    const key = await seedKeyFor(m);
    const retried = await request(h.app).post(`/v1/webhook-deliveries/${d.id}/retry`).set(key);
    expect(retried.body.status).toBe('pending');
    respondWith = 200;
    now = new Date(Date.now() + 1000);
    expect((await step()).status).toBe('succeeded');
  });

  it('does not follow redirects', async () => {
    await endpointAndPayment();
    respondWith = 302;
    await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: sender() });
    const [d] = await h.db.select().from(webhookDeliveries);
    expect(d).toMatchObject({ status: 'pending', responseCode: 302 });
    expect(received).toHaveLength(1);
  });

  it('re-checks SSRF at send time (blocked in strict mode)', async () => {
    await endpointAndPayment();
    const strict = createSender({ policy: { allowInsecure: false }, timeoutMs: 2_000 });
    await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: strict });
    expect(received).toHaveLength(0);
    const [d] = await h.db.select().from(webhookDeliveries);
    expect(d?.error).toContain('blocked');
  });

  it('two workers never send the same delivery (SKIP LOCKED claim)', async () => {
    await endpointAndPayment();
    const deps = { config: h.config, db: h.db, logger: h.logger, send: sender() };
    const [a, b] = await Promise.all([runDispatcherBatch(deps), runDispatcherBatch(deps)]);
    expect(a + b).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('delivers the full lifecycle after indexing, in order, at least once', async () => {
    const { paymentId, m } = await endpointAndPayment();
    h.chain.pay(paymentId, Keypair.random().publicKey());
    await runIndexerBatch({ config: h.config, db: h.db, chain: h.chain, logger: h.logger });
    await request(h.app).post(`/v1/payments/${paymentId}/settle`).set(m.auth);
    await runIndexerBatch({ config: h.config, db: h.db, chain: h.chain, logger: h.logger });
    await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: sender() });
    expect(received.map((r) => (JSON.parse(r.body) as { type: string }).type)).toEqual(['payment.created', 'payment.paid', 'payment.settled']);
    const list = await request(h.app).get('/v1/webhook-deliveries').set(m.auth);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.every((d: { status: string }) => d.status === 'succeeded')).toBe(true);
  });

  it('skips disabled endpoints', async () => {
    const { m, endpointId } = await endpointAndPayment();
    await request(h.app).patch(`/v1/webhook-endpoints/${endpointId}`).set(m.auth).send({ enabled: false });
    await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: sender() });
    expect(received).toHaveLength(0);
  });
});

async function seedKeyFor(merchantId: string) {
  const { generateApiKey, SCOPES } = await import('../src/auth/apiKeys.js');
  const { TEST_PEPPER } = await import('./helpers.js');
  const { key, prefix, hash } = generateApiKey(TEST_PEPPER);
  await repo.insertApiKey(h.db, { merchantId, prefix, hash, scopes: [...SCOPES] });
  return { Authorization: `Bearer ${key}` };
}
