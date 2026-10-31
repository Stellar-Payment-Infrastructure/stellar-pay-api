/**
 * Negative end-to-end flows (Phase 8): everything goes through HTTP, the
 * indexer and the webhook dispatcher against the contract model.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Account, Contract, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo.js';
import { SimulationError, PAY_TOKEN_ERRORS } from '../src/errors.js';
import { runIndexerBatch } from '../src/indexer/indexer.js';
import { addressToScVal, paymentIdToScVal } from '../src/stellar/contract.js';
import { runDispatcherBatch } from '../src/webhooks/dispatcher.js';
import { createSender } from '../src/webhooks/http.js';
import { CONTRACT_ID, createHarness, type Harness, idem, seedMerchant } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function newPayment() {
  const m = await seedMerchant(h.db);
  const p = await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '1000' });
  expect(p.status).toBe(201);
  return { m, id: p.body.id as string };
}

async function buildAndSign(id: string, payer: Keypair) {
  const built = await request(h.app).post(`/v1/public/payments/${id}/transaction`).send({ payer: payer.publicKey() });
  expect(built.status).toBe(200);
  const tx = TransactionBuilder.fromXDR(built.body.transactionXdr as string, built.body.networkPassphrase as string);
  tx.sign(payer);
  return tx.toXDR();
}

describe('negative end-to-end', () => {
  it('payer cancels in the wallet: nothing is submitted and the payment stays payable', async () => {
    const { id } = await newPayment();
    await buildAndSign(id, Keypair.random()); // built, but the payer never signs/submits
    expect(h.chain.calls).not.toContain('submit');
    expect((await request(h.app).get(`/v1/public/payments/${id}`)).body.status).toBe('created');
    // A later attempt still works.
    const payer = Keypair.random();
    const res = await request(h.app).post(`/v1/public/payments/${id}/submit`).send({ signedXdr: await buildAndSign(id, payer) });
    expect(res.body.status).toBe('paid');
  });

  it('insufficient balance surfaces as INSUFFICIENT_BALANCE, not a contract error', async () => {
    const { id } = await newPayment();
    // What the RPC client produces when the token transfer inside pay fails.
    h.chain.buildPayTransaction = async () => {
      throw new SimulationError(10, 'HostError: Error(Contract, #10)', PAY_TOKEN_ERRORS);
    };
    const res = await request(h.app).post(`/v1/public/payments/${id}/transaction`).send({ payer: Keypair.random().publicKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await repo.findPayment(h.db, id))?.status).toBe('created');
  });

  it('wrong network: an envelope signed for another network is rejected before submission', async () => {
    const { id } = await newPayment();
    const payer = Keypair.random();
    const tx = new TransactionBuilder(new Account(payer.publicKey(), '1'), { fee: '1000', networkPassphrase: Networks.FUTURENET })
      .addOperation(new Contract(CONTRACT_ID).call('pay', addressToScVal(payer.publicKey()), paymentIdToScVal(id)))
      .setTimeout(300)
      .build();
    tx.sign(payer);
    const res = await request(h.app).post(`/v1/public/payments/${id}/submit`).send({ signedXdr: tx.toXDR() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_TRANSACTION', details: { reason: 'signature' } });
    expect(h.chain.calls).not.toContain('submit');
  });

  it('payment already paid: building and submitting again are refused', async () => {
    const { id } = await newPayment();
    const payer = Keypair.random();
    const signed = await buildAndSign(id, payer);
    expect((await request(h.app).post(`/v1/public/payments/${id}/submit`).send({ signedXdr: signed })).status).toBe(200);
    const again = await request(h.app).post(`/v1/public/payments/${id}/submit`).send({ signedXdr: signed });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_NOT_PAYABLE');
    const rebuild = await request(h.app).post(`/v1/public/payments/${id}/transaction`).send({ payer: payer.publicKey() });
    expect(rebuild.body.error.code).toBe('PAYMENT_NOT_PAYABLE');
  });

  it('RPC down: requests fail with 503, no state changes, and recovery is automatic', async () => {
    const { m, id } = await newPayment();
    h.chain.rpcDown = true;
    const build = await request(h.app).post(`/v1/public/payments/${id}/transaction`).send({ payer: Keypair.random().publicKey() });
    expect(build.status).toBe(503);
    expect(build.body.error.code).toBe('RPC_UNAVAILABLE');
    const create = await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '5' });
    expect(create.status).toBe(503);
    expect((await repo.listPayments(h.db, { merchantId: m.merchant.id, limit: 10 })).length).toBe(1);
    await expect(runIndexerBatch({ config: h.config, db: h.db, chain: h.chain, logger: h.logger })).rejects.toThrow();
    h.chain.rpcDown = false;
    expect((await request(h.app).post(`/v1/public/payments/${id}/transaction`).send({ payer: Keypair.random().publicKey() })).status).toBe(200);
  });

  it('webhook endpoint down: deliveries are retried and succeed once it is back', async () => {
    let up = false;
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => {
        res.statusCode = up ? 200 : 503;
        if (up) got.push((JSON.parse(b) as { type: string }).type);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const m = await seedMerchant(h.db);
      await request(h.app).post('/v1/webhook-endpoints').set(m.auth).send({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/h` });
      await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '5' });
      const send = createSender({ policy: { allowInsecure: true }, timeoutMs: 2_000 });
      let now = new Date();
      const run = () => runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send, now: () => now });
      await run();
      expect(got).toEqual([]);
      up = true;
      now = new Date(Date.now() + 10 * 60_000);
      await run();
      expect(got).toEqual(['payment.created']);
    } finally {
      server.close();
    }
  });
});

describe('scale sanity', () => {
  it('lists 5,000 payments through cursor pagination without gaps or duplicates', async () => {
    const m = await seedMerchant(h.db);
    const base = Date.UTC(2026, 0, 1);
    const values = Array.from({ length: 5_000 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'),
      merchantId: m.merchant.id,
      status: 'created' as const,
      amount: String(i + 1),
      token: h.config.PAY_TOKEN_CONTRACT_ID,
      merchantAddress: m.merchant.payoutAddress,
      settleMode: 'manual' as const,
      referenceHash: '00'.repeat(32),
      // Groups of 7 share a timestamp to exercise the (createdAt, id) tiebreak.
      createdAt: new Date(base + Math.floor(i / 7) * 1000),
      updatedAt: new Date(base + Math.floor(i / 7) * 1000),
    }));
    const { payments } = await import('../src/db/schema.js');
    for (let i = 0; i < values.length; i += 1000) await h.db.insert(payments).values(values.slice(i, i + 1000));
    const started = Date.now();
    for (const query of [{}, { updated_since: '2000-01-01T00:00:00Z' }]) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await request(h.app).get('/v1/payments').query({ limit: 100, ...query, ...(cursor ? { cursor } : {}) }).set(m.auth);
        expect(res.status).toBe(200);
        for (const p of res.body.data as { id: string }[]) {
          expect(seen.has(p.id)).toBe(false);
          seen.add(p.id);
        }
        cursor = res.body.nextCursor as string | null;
        pages++;
      } while (cursor);
      expect(seen.size).toBe(5_000);
      expect(pages).toBe(50);
    }
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);
});
