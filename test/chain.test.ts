import { randomBytes } from 'node:crypto';
import { Account, Keypair, rpc, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ChainTimeoutError, RpcUnavailableError, SimulationError, SubmitError } from '../src/errors.js';
import { EventsOutOfRetentionError, RpcChainClient, type RpcLike } from '../src/stellar/chain.js';
import { CONTRACT_ID, OPERATOR, structScVal } from './helpers.js';

const TESTNET = 'Test SDF Network ; September 2015';
const id = randomBytes(32).toString('hex');

function successSim(retval?: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '1000',
    result: { auth: [], retval: retval ?? xdr.ScVal.scvVoid() },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

function errorSim(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error } as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

function stub(over: Partial<Record<keyof RpcLike, unknown>> = {}): RpcLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  const base = {
    sent,
    getAccount: async (a: string) => new Account(a, '1'),
    simulateTransaction: async () => successSim(),
    sendTransaction: async (tx: { hash(): Buffer }) => {
      sent.push(tx);
      return { status: 'PENDING', hash: tx.hash().toString('hex'), latestLedger: 1, latestLedgerCloseTime: 0 };
    },
    getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
    getEvents: async () => ({ events: [], cursor: 'c', latestLedger: 5, oldestLedger: 1 }),
    getLatestLedger: async () => ({ sequence: 42 }),
  };
  return { ...base, ...over } as unknown as RpcLike & { sent: unknown[] };
}

const client = (r: RpcLike, extra: Partial<ConstructorParameters<typeof RpcChainClient>[0]> = {}) =>
  new RpcChainClient({
    rpc: r,
    contractId: CONTRACT_ID,
    networkPassphrase: TESTNET,
    operatorSecret: OPERATOR.secret(),
    confirmTimeoutMs: 50,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    ...extra,
  });

describe('RpcChainClient', () => {
  it('simulates, assembles, signs with the operator and confirms', async () => {
    const r = stub();
    const res = await client(r).settle(id);
    expect(res.txHash).toMatch(/^[0-9a-f]{64}$/);
    const tx = r.sent[0] as { signatures: unknown[]; source: string; operations: { type: string }[] };
    expect(tx.source).toBe(OPERATOR.publicKey());
    expect(tx.signatures).toHaveLength(1);
    expect(tx.operations[0]?.type).toBe('invokeHostFunction');
  });

  it('maps simulation failures to contract error codes', async () => {
    const r = stub({ simulateTransaction: async () => errorSim('HostError: Error(Contract, #7)\n\nEvent log...') });
    const err = await client(r).settle(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulationError);
    expect((err as SimulationError).code).toBe('INVALID_PAYMENT_STATE');
    expect((err as SimulationError).status).toBe(409);
    const other = stub({ simulateTransaction: async () => errorSim('HostError: Error(Auth, InvalidAction)') });
    const err2 = (await client(other).settle(id).catch((e: unknown) => e)) as SimulationError;
    expect(err2.code).toBe('SIMULATION_FAILED');
    expect(JSON.stringify(err2.details)).not.toContain('Event log');
  });

  it('maps token errors raised inside pay/settle to token-level codes, not ours', async () => {
    const sim = (code: number) => stub({ simulateTransaction: async () => errorSim(`HostError: Error(Contract, #${code})`) });
    const payer = Keypair.random().publicKey();
    await expect(client(sim(10)).buildPayTransaction(payer, id)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    await expect(client(sim(13)).buildPayTransaction(payer, id)).rejects.toMatchObject({ code: 'TRUSTLINE_MISSING' });
    await expect(client(sim(7)).buildPayTransaction(payer, id)).rejects.toMatchObject({ code: 'INVALID_PAYMENT_STATE' });
    await expect(client(sim(13)).settle(id)).rejects.toMatchObject({ code: 'RECIPIENT_TRUSTLINE_MISSING' });
    // create_payment never calls the token: 13 is ours there.
    await expect(
      client(sim(13)).createPayment({ paymentId: id, merchant: payer, amount: 1n, referenceHash: id, settleMode: 'manual' }),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it('reports rejected, failed and timed-out submissions with typed errors', async () => {
    const rejected = stub({ sendTransaction: async () => ({ status: 'ERROR', hash: 'h' }) });
    await expect(client(rejected).cancel(id)).rejects.toBeInstanceOf(SubmitError);
    const failed = stub({ getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED }) });
    await expect(client(failed).cancel(id)).rejects.toBeInstanceOf(SubmitError);
    const pending = stub({ getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }) });
    await expect(client(pending, { confirmTimeoutMs: 0 }).cancel(id)).rejects.toBeInstanceOf(ChainTimeoutError);
    const lost = stub({ sendTransaction: async () => { throw new Error('socket hang up'); } });
    await expect(client(lost).cancel(id)).rejects.toBeInstanceOf(ChainTimeoutError);
    const down = stub({ getAccount: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(client(down).cancel(id)).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it('serializes operator transactions so sequence numbers never race', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const r = stub({
      simulateTransaction: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return successSim();
      },
    });
    const c = client(r);
    const results = await Promise.allSettled([c.settle(id), c.refund(id), c.cancel(id)]);
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it('builds the payer transaction with the payer as source and a bounded validity', async () => {
    const payer = Keypair.random().publicKey();
    const { xdr: built, validUntil } = await client(stub()).buildPayTransaction(payer, id);
    expect(built).toBeTruthy();
    expect(validUntil - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    const missing = stub({ getAccount: async () => { throw new Error('Account not found: G...'); } });
    await expect(client(missing).buildPayTransaction(payer, id)).rejects.toMatchObject({ code: 'PAYER_ACCOUNT_NOT_FOUND' });
  });

  it('decodes get_payment and treats NotFound as null', async () => {
    const addr = (a: string) => xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(Keypair.fromPublicKey(a).rawPublicKey())));
    const merchant = Keypair.random().publicKey();
    const retval = structScVal({
      operator: addr(OPERATOR.publicKey()),
      merchant: addr(merchant),
      payer: xdr.ScVal.scvVoid(),
      token: addr(merchant),
      amount: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('500') })),
      fee_bps: xdr.ScVal.scvU32(100),
      fee_recipient: xdr.ScVal.scvVoid(),
      reference: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
      settle_mode: xdr.ScVal.scvU32(1),
      condition: xdr.ScVal.scvU32(0),
      status: xdr.ScVal.scvU32(0),
      created_at: xdr.ScVal.scvU64(xdr.Uint64.fromString('1700000000')),
      paid_at: xdr.ScVal.scvVoid(),
      closed_at: xdr.ScVal.scvVoid(),
      version: xdr.ScVal.scvU32(1),
    });
    const p = await client(stub({ simulateTransaction: async () => successSim(retval) })).getPayment(id);
    expect(p).toMatchObject({ status: 'created', merchant, amount: 500n, payer: null, settleMode: 'manual', feeBps: 100 });
    const nf = stub({ simulateTransaction: async () => errorSim('HostError: Error(Contract, #3)') });
    expect(await client(nf).getPayment(id)).toBeNull();
  });

  it('distinguishes out-of-retention event queries from outages', async () => {
    const old = stub({ getEvents: async () => { throw new Error('startLedger must be within the ledger range: 1000 - 2000'); } });
    await expect(client(old).getEvents({ startLedger: 1 }, 10)).rejects.toBeInstanceOf(EventsOutOfRetentionError);
    const down = stub({ getEvents: async () => { throw new Error('ECONNRESET'); } });
    await expect(client(down).getEvents({ cursor: 'x' }, 10)).rejects.toBeInstanceOf(RpcUnavailableError);
    expect(await client(stub()).getLatestLedger()).toBe(42);
  });
});
