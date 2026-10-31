import { readFileSync } from 'node:fs';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../src/db/repo.js';
import { chainEvents, paymentEvents, webhookDeliveries } from '../src/db/schema.js';
import { CURSOR_KEY, eventIndexOf, runIndexerBatch, runReconciler } from '../src/indexer/indexer.js';
import { createHarness, FakeChain, type Harness, idem, seedMerchant } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function setup() {
  const m = await seedMerchant(h.db);
  await request(h.app).post('/v1/webhook-endpoints').set(m.auth).send({ url: 'https://merchant.example/hook' });
  return m;
}

async function create(auth: { Authorization: string }, body: Record<string, unknown> = { amount: '1000' }) {
  const res = await request(h.app).post('/v1/payments').set(auth).set(idem()).send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const deps = () => ({ config: h.config, db: h.db, chain: h.chain, logger: h.logger });

describe('indexer', () => {
  it('parses RPC event ids', () => {
    expect(eventIndexOf('0000000000000123456-0000000002')).toBe(2);
    expect(eventIndexOf('garbage')).toBe(0);
  });

  it('applies paid/settled events, records tx hashes and enqueues webhooks once', async () => {
    const m = await setup();
    const id = await create(m.auth);
    const payer = Keypair.random().publicKey();
    h.chain.pay(id, payer);
    const first = await runIndexerBatch(deps());
    expect(first.applied).toBe(1); // the created event was already applied by the route
    let p = await repo.findPayment(h.db, id);
    expect(p).toMatchObject({ status: 'paid', payer, feeBps: 100 });
    expect(p?.payTxHash).toMatch(/^[0-9a-f]{64}$/);

    await h.chain.settle(id);
    await runIndexerBatch(deps());
    p = await repo.findPayment(h.db, id);
    expect(p).toMatchObject({ status: 'settled', fee: '10' });

    const events = await repo.listPaymentEvents(h.db, id);
    expect(events.map((e) => e.type)).toEqual(['payment.created', 'payment.paid', 'payment.settled']);
    const deliveries = await h.db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(3);
    expect((await repo.getIndexerState(h.db, CURSOR_KEY))?.cursor).toBe(h.chain.events.at(-1)?.id);
  });

  it('replaying the same batch twice has no double effects', async () => {
    const m = await setup();
    const id = await create(m.auth);
    h.chain.pay(id, Keypair.random().publicKey());
    await runIndexerBatch(deps());
    const countsBefore = await counts();
    // Rewind the cursor: the same events come back.
    await repo.setIndexerState(h.db, CURSOR_KEY, '0', 0);
    const replay = await runIndexerBatch(deps());
    expect(replay.fetched).toBeGreaterThan(0);
    expect(replay.inserted).toBe(0);
    expect(await counts()).toEqual(countsBefore);
  });

  it('never moves a payment backwards (out-of-order events)', async () => {
    const m = await setup();
    const id = await create(m.auth);
    h.chain.pay(id, Keypair.random().publicKey());
    await h.chain.settle(id);
    // Deliver the settled event before the paid event.
    const [created, paid, settled] = h.chain.events as [typeof h.chain.events[0], typeof h.chain.events[0], typeof h.chain.events[0]];
    h.chain.events = [created, settled, { ...paid, id: `${'9'.repeat(19)}-0000000000`, ledger: 99_999 }];
    await runIndexerBatch(deps());
    const p = await repo.findPayment(h.db, id);
    expect(p?.status).toBe('settled');
    // payment.paid is still emitted for the skipped state, exactly once.
    const types = (await repo.listPaymentEvents(h.db, id)).map((e) => e.type);
    expect(types).toEqual(['payment.created', 'payment.paid', 'payment.settled']);
  });

  it('auto-settle produces paid then settled from one transaction', async () => {
    const m = await setup();
    const id = await create(m.auth, { amount: '50000', settleMode: 'auto' });
    h.chain.pay(id, Keypair.random().publicKey());
    await runIndexerBatch(deps());
    expect((await repo.findPayment(h.db, id))?.status).toBe('settled');
    expect((await repo.listPaymentEvents(h.db, id)).map((e) => e.type)).toEqual(['payment.created', 'payment.paid', 'payment.settled']);
  });

  it('a crash mid-batch rolls back everything, and the next run converges', async () => {
    const m = await setup();
    const id = await create(m.auth);
    h.chain.pay(id, Keypair.random().publicKey());
    const before = await counts();
    // Poison the second event so processing throws inside the DB transaction.
    const good = h.chain.events.slice();
    const poisoned = { ...(good[1] as (typeof good)[0]), get topics(): xdr.ScVal[] { throw new Error('boom'); } };
    h.chain.events = [good[0] as (typeof good)[0], poisoned as unknown as (typeof good)[0]];
    await expect(runIndexerBatch(deps())).rejects.toThrow('boom');
    expect(await counts()).toEqual(before);
    expect(await repo.getIndexerState(h.db, CURSOR_KEY)).toBeUndefined();
    h.chain.events = good;
    await runIndexerBatch(deps());
    expect((await repo.findPayment(h.db, id))?.status).toBe('paid');
  });

  it('ignores events for unknown payments and refuses inconsistent ones', async () => {
    const m = await setup();
    const id = await create(m.auth, { amount: '1000' });
    // An event claiming a different amount must not be applied.
    h.chain.payments.get(id)!.amount = 999n;
    h.chain.pay(id, Keypair.random().publicKey());
    h.chain.payments.set('ee'.repeat(32), { ...h.chain.payments.get(id)!, id: 'ee'.repeat(32), status: 'created' });
    h.chain.pay('ee'.repeat(32), Keypair.random().publicKey());
    const res = await runIndexerBatch(deps());
    expect(res.skipped).toBe(1);
    expect((await repo.findPayment(h.db, id))?.status).toBe('created');
    expect(await repo.findPayment(h.db, 'ee'.repeat(32))).toBeUndefined();
  });

  it('logs and skips unknown event versions without crashing', async () => {
    await setup();
    h.chain.events.push({
      id: '0000000000000005000-0000000000',
      ledger: 5000,
      txHash: 'aa'.repeat(32),
      contractId: h.chain.contractId,
      topics: [xdr.ScVal.scvSymbol('pay'), xdr.ScVal.scvSymbol('paid')],
      value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('v'), val: xdr.ScVal.scvU32(9) })]),
      inSuccessfulContractCall: true,
    });
    const res = await runIndexerBatch(deps());
    expect(res).toMatchObject({ inserted: 1, skipped: 1 });
    expect(h.logs.some((l) => l.includes('unsupported event version 9'))).toBe(true);
  });

  it('indexes the events emitted by the real contract (core test vectors)', async () => {
    const vectors = JSON.parse(readFileSync(new URL('../src/generated/contract-test-vectors.json', import.meta.url), 'utf8')) as {
      events: { name: string; topics_xdr: string[]; data_xdr: string; expected: Record<string, string | number> }[];
    };
    const m = await seedMerchant(h.db);
    // Recreate the payments the vectors refer to, as if this API had created them.
    for (const v of vectors.events.filter((e) => e.name === 'created')) {
      await repo.insertPayment(h.db, {
        id: v.expected['payment_id'] as string,
        merchantId: m.merchant.id,
        status: 'pending',
        amount: v.expected['amount'] as string,
        token: v.expected['token'] as string,
        merchantAddress: v.expected['merchant'] as string,
        settleMode: v.expected['settle_mode'] as 'manual',
        referenceHash: v.expected['reference'] as string,
      });
    }
    // The vectors only carry the final events for 0x22/0x33 (refund, reclaim), 0x44 (cancel) and 0x55 (auto):
    // seed those rows in the state they had before those events.
    const merchantAddr = vectors.events.find((e) => e.name === 'created')!.expected['merchant'] as string;
    const token = vectors.events.find((e) => e.name === 'created')!.expected['token'] as string;
    for (const v of vectors.events.filter((e) => e.name !== 'created')) {
      const pid = v.expected['payment_id'] as string;
      if (!(await repo.findPayment(h.db, pid))) {
        await repo.insertPayment(h.db, {
          id: pid, merchantId: m.merchant.id, status: v.name === 'refunded' ? 'paid' : 'created', amount: amountOf(v.expected),
          token, merchantAddress: merchantAddr, settleMode: 'manual', referenceHash: '00'.repeat(32),
        });
      }
    }
    // The vectors were produced by core tests with their own operator address.
    h.chain.operatorAddress = vectors.events.find((e) => e.name === 'created')!.expected['operator'] as string;
    h.chain.events = vectors.events.map((v, i) => ({
      id: `${String(10_000 + i).padStart(19, '0')}-0000000000`,
      ledger: 10_000 + i,
      txHash: String(i).padStart(64, '0'),
      contractId: h.chain.contractId,
      topics: v.topics_xdr.map((t) => xdr.ScVal.fromXDR(t, 'base64')),
      value: xdr.ScVal.fromXDR(v.data_xdr, 'base64'),
      inSuccessfulContractCall: true,
    }));
    const res = await runIndexerBatch(deps());
    expect(res.skipped).toBe(0);
    const statusOf = async (n: string) => (await repo.findPayment(h.db, n.repeat(32)))?.status;
    expect(await statusOf('11')).toBe('settled');
    expect(await statusOf('22')).toBe('refunded');
    expect(await statusOf('33')).toBe('refunded');
    expect(await statusOf('44')).toBe('cancelled');
    expect(await statusOf('55')).toBe('settled');
    expect((await repo.findPayment(h.db, '11'.repeat(32)))?.fee).toBe('10000');
  });

  it('load sanity: 10k events across 2.5k payments', async () => {
    const m = await seedMerchant(h.db);
    const ids: string[] = [];
    for (let i = 0; i < 2_500; i++) {
      const id = i.toString(16).padStart(64, '0');
      ids.push(id);
      await repo.insertPayment(h.db, {
        id, merchantId: m.merchant.id, status: 'pending', amount: '1000', token: h.config.PAY_TOKEN_CONTRACT_ID,
        merchantAddress: m.merchant.payoutAddress, settleMode: 'manual', referenceHash: '00'.repeat(32),
      });
      await h.chain.createPayment({ paymentId: id, merchant: m.merchant.payoutAddress, amount: 1000n, referenceHash: '00'.repeat(32), settleMode: 'manual' });
      h.chain.pay(id, Keypair.random().publicKey());
      await h.chain.settle(id);
    }
    // 2.5k create + 2.5k paid + 2.5k settled = 7.5k; add 2.5k foreign events to reach 10k.
    for (let i = 0; i < 2_500; i++) {
      const fid = (100_000 + i).toString(16).padStart(64, '0');
      await h.chain.createPayment({ paymentId: fid, merchant: m.merchant.payoutAddress, amount: 1n, referenceHash: '00'.repeat(32), settleMode: 'manual' });
    }
    expect(h.chain.events).toHaveLength(10_000);
    // Index from the beginning (the default start is "latest - 1000 ledgers").
    await repo.setIndexerState(h.db, CURSOR_KEY, '0', 0);
    const started = Date.now();
    let total = 0;
    for (;;) {
      const r = await runIndexerBatch(deps(), 1_000);
      total += r.inserted;
      if (r.fetched === 0) break;
    }
    const ms = Date.now() - started;
    console.warn(`indexed 10k events in ${ms} ms`);
    expect(total).toBe(10_000);
    const settled = await repo.listPayments(h.db, { merchantId: m.merchant.id, status: 'settled', limit: 5_000 });
    expect(settled).toHaveLength(2_500);
    expect(ms).toBeLessThan(120_000);
  }, 300_000);
});

describe('reconciler', () => {
  it('repairs payments whose events were missed (RPC retention gap)', async () => {
    const m = await setup();
    const id = await create(m.auth);
    h.chain.pay(id, Keypair.random().publicKey());
    h.chain.events = []; // events fell out of retention
    await runIndexerBatch(deps());
    expect((await repo.findPayment(h.db, id))?.status).toBe('created');
    const res = await runReconciler(deps());
    expect(res.repaired).toBe(1);
    expect((await repo.findPayment(h.db, id))?.status).toBe('paid');
    expect((await repo.listPaymentEvents(h.db, id)).map((e) => e.type)).toContain('payment.paid');
  });

  it('confirms pending creates that landed, and fails ones that never did', async () => {
    const m = await setup();
    const { ChainTimeoutError } = await import('../src/errors.js');
    // Outcome unknown, but it did land on-chain.
    const real = h.chain.createPayment.bind(h.chain);
    h.chain.createPayment = async (a) => {
      await real(a);
      throw new ChainTimeoutError('cc'.repeat(32));
    };
    const landed = (await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '7' })).body.id as string;
    // Outcome unknown, and it never landed.
    h.chain.createPayment = async () => {
      throw new ChainTimeoutError('dd'.repeat(32));
    };
    const lost = (await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '8' })).body.id as string;
    expect((await repo.findPayment(h.db, landed))?.status).toBe('pending');

    const res = await runReconciler(deps());
    expect(res).toMatchObject({ checked: 2, repaired: 1, failed: 1 });
    expect((await repo.findPayment(h.db, landed))?.status).toBe('created');
    expect((await repo.findPayment(h.db, lost))?.status).toBe('failed');
    // Failed payments are invisible to payers.
    expect((await request(h.app).get(`/v1/public/payments/${lost}`)).status).toBe(404);
  });

  it('never adopts an on-chain record created under our id by someone else (front-run create)', async () => {
    const m = await setup();
    const { ChainTimeoutError } = await import('../src/errors.js');
    const attacker = Keypair.random().publicKey();
    // Our create times out; meanwhile an attacker created the same id with their own operator and merchant.
    h.chain.createPayment = async (a) => {
      await FakeChain.prototype.createPayment.call(h.chain, { ...a, merchant: attacker }, attacker);
      throw new ChainTimeoutError('ee'.repeat(32));
    };
    const id = (await request(h.app).post('/v1/payments').set(m.auth).set(idem()).send({ amount: '500' })).body.id as string;
    expect((await repo.findPayment(h.db, id))?.status).toBe('pending');
    // The attacker's created event must not confirm our row...
    const batch = await runIndexerBatch(deps());
    expect(batch.skipped).toBe(1);
    expect((await repo.findPayment(h.db, id))?.status).toBe('pending');
    // ...nor may the reconciler adopt the attacker's record: ours never landed.
    const res = await runReconciler(deps());
    expect(res).toMatchObject({ repaired: 0, failed: 1 });
    expect((await repo.findPayment(h.db, id))?.status).toBe('failed');
    expect(h.logs.some((l) => l.includes('not ours'))).toBe(true);
  });

  it('survives RPC outages without changing state', async () => {
    const m = await setup();
    const id = await create(m.auth);
    h.chain.rpcDown = true;
    await expect(runIndexerBatch(deps())).rejects.toThrow();
    const res = await runReconciler(deps());
    expect(res.repaired).toBe(0);
    expect((await repo.findPayment(h.db, id))?.status).toBe('created');
  });
});

/** Payment amount implied by a vector (cancelled events carry none). */
function amountOf(e: Record<string, string | number>): string {
  if (e['amount'] !== undefined) return String(e['amount']);
  if (e['merchant_amount'] !== undefined) return (BigInt(e['merchant_amount']) + BigInt(e['fee'] as string)).toString();
  return '900';
}

async function counts() {
  const [ce, pe, wd] = await Promise.all([
    h.db.select().from(chainEvents),
    h.db.select().from(paymentEvents),
    h.db.select().from(webhookDeliveries),
  ]);
  return { chainEvents: ce.length, paymentEvents: pe.length, deliveries: wd.length };
}
