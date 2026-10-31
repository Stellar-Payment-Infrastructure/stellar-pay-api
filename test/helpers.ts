import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { generateApiKey, SCOPES, type Scope } from '../src/auth/apiKeys.js';
import { type Config, loadConfig, TESTNET_PASSPHRASE } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import * as repo from '../src/db/repo.js';
import { RpcUnavailableError, SimulationError } from '../src/errors.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { ChainClient, ChainEvent, CreatePaymentArgs, EventsPage } from '../src/stellar/chain.js';
import { addressToScVal, type OnChainPayment, paymentIdToScVal, type SettleMode } from '../src/stellar/contract.js';
import { createTestDb } from './db.js';

export const OPERATOR = Keypair.random();
export const CONTRACT_ID = StrKey.encodeContract(randomBytes(32));
export const TOKEN_ID = StrKey.encodeContract(randomBytes(32));
export const FEE_RECIPIENT = Keypair.random().publicKey();
/** Recognizable fake secrets so log tests can grep for them. */
export const TEST_PEPPER = 'pepper-pepper-pepper-pepper-pepper-0001';
export const TEST_ENC_KEY = 'ab'.repeat(32);

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'pglite://memory',
    PAY_CONTRACT_ID: CONTRACT_ID,
    PAY_TOKEN_CONTRACT_ID: TOKEN_ID,
    OPERATOR_SECRET: OPERATOR.secret(),
    API_KEY_PEPPER: TEST_PEPPER,
    WEBHOOK_SECRET_ENC_KEY: TEST_ENC_KEY,
    NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    WEBHOOK_ALLOW_INSECURE: 'true',
    PUBLIC_RATE_LIMIT_PER_MIN: '1000',
    RECONCILE_AFTER_MS: '0',
    CORS_ORIGINS: 'https://checkout.example',
    ...overrides,
  });
}

// ------------------------------------------------------------------ fake chain

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const u64 = (n: number) => nativeToScVal(BigInt(n), { type: 'u64' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

/** Encodes a contracttype struct the way soroban-sdk does: ScMap, symbol keys sorted. */
export function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const keys = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(keys.map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] as xdr.ScVal })));
}

interface FakePayment extends OnChainPayment {
  id: string;
}

/**
 * In-memory model of the payments contract + RPC. Enforces the same state
 * machine and error codes as stellar-pay-core and emits events with the
 * contract's XDR encoding, so the indexer can consume them.
 */
export class FakeChain implements ChainClient {
  readonly contractId = CONTRACT_ID;
  readonly networkPassphrase = TESTNET_PASSPHRASE;
  operatorAddress = OPERATOR.publicKey();
  payments = new Map<string, FakePayment>();
  events: ChainEvent[] = [];
  ledger = 1000;
  now = 1_700_000_000;
  feeBps = 100;
  calls: string[] = [];
  /** Set to make the next operator call fail like the network would. */
  failNext: Error | null = null;
  rpcDown = false;
  private txCounter = 0;

  private hash(): string {
    this.txCounter++;
    return randomBytes(32).toString('hex');
  }

  private guard(fn: string) {
    this.calls.push(fn);
    if (this.rpcDown) throw new RpcUnavailableError();
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  private emit(txHash: string, name: string, data: Record<string, xdr.ScVal>) {
    this.ledger++;
    const index = this.events.filter((e) => e.txHash === txHash).length;
    this.events.push({
      id: `${String(this.ledger).padStart(19, '0')}-${String(index).padStart(10, '0')}`,
      ledger: this.ledger,
      txHash,
      contractId: this.contractId,
      topics: [sym('pay'), sym(name)],
      value: structScVal({ v: u32(1), ...data }),
      inSuccessfulContractCall: true,
    });
  }

  async createPayment(a: CreatePaymentArgs, operator: string = OPERATOR.publicKey()) {
    this.guard('create_payment');
    if (this.payments.has(a.paymentId)) throw new SimulationError(4, 'Error(Contract, #4)');
    const txHash = this.hash();
    this.payments.set(a.paymentId, {
      id: a.paymentId,
      operator,
      merchant: a.merchant,
      payer: null,
      token: TOKEN_ID,
      amount: a.amount,
      feeBps: this.feeBps,
      feeRecipient: null,
      reference: a.referenceHash,
      settleMode: a.settleMode,
      status: 'created',
      createdAt: this.now,
      paidAt: null,
      closedAt: null,
      version: 1,
    });
    this.emit(txHash, 'created', {
      payment_id: paymentIdToScVal(a.paymentId),
      operator: addressToScVal(operator),
      merchant: addressToScVal(a.merchant),
      token: addressToScVal(TOKEN_ID),
      amount: i128(a.amount),
      reference: paymentIdToScVal(a.referenceHash),
      settle_mode: u32(a.settleMode === 'auto' ? 0 : 1),
      created_at: u64(this.now),
    });
    return { txHash };
  }

  private need(id: string, status: OnChainPayment['status']): FakePayment {
    const p = this.payments.get(id);
    if (!p) throw new SimulationError(3, 'Error(Contract, #3)');
    if (p.status !== status) throw new SimulationError(7, 'Error(Contract, #7)');
    return p;
  }

  private emitSettled(txHash: string, p: FakePayment) {
    const fee = (p.amount * BigInt(p.feeBps)) / 10_000n;
    this.emit(txHash, 'settled', {
      payment_id: paymentIdToScVal(p.id),
      merchant: addressToScVal(p.merchant),
      fee_recipient: addressToScVal(FEE_RECIPIENT),
      merchant_amount: i128(p.amount - fee),
      fee: i128(fee),
      settled_at: u64(this.now),
    });
  }

  /** Simulates the payer's pay() landing on-chain. */
  pay(id: string, payer: string): string {
    const p = this.need(id, 'created');
    const txHash = this.hash();
    p.payer = payer;
    p.feeBps = this.feeBps;
    p.feeRecipient = FEE_RECIPIENT;
    p.paidAt = this.now;
    p.status = p.settleMode === 'auto' ? 'settled' : 'paid';
    this.emit(txHash, 'paid', {
      payment_id: paymentIdToScVal(id),
      payer: addressToScVal(payer),
      amount: i128(p.amount),
      fee_bps: u32(p.feeBps),
      paid_at: u64(this.now),
    });
    if (p.settleMode === 'auto') this.emitSettled(txHash, p);
    return txHash;
  }

  async settle(id: string) {
    this.guard('settle');
    const p = this.need(id, 'paid');
    const txHash = this.hash();
    p.status = 'settled';
    this.emitSettled(txHash, p);
    return { txHash };
  }

  async cancel(id: string) {
    this.guard('cancel');
    const p = this.need(id, 'created');
    const txHash = this.hash();
    p.status = 'cancelled';
    this.emit(txHash, 'cancelled', { payment_id: paymentIdToScVal(id), cancelled_at: u64(this.now) });
    return { txHash };
  }

  async refund(id: string) {
    this.guard('refund');
    const p = this.need(id, 'paid');
    const txHash = this.hash();
    p.status = 'refunded';
    this.emit(txHash, 'refunded', {
      payment_id: paymentIdToScVal(id),
      payer: addressToScVal(p.payer as string),
      amount: i128(p.amount),
      reason: u32(0),
      refunded_at: u64(this.now),
    });
    return { txHash };
  }

  async buildPayTransaction(payer: string, paymentId: string) {
    this.guard('build_pay');
    this.need(paymentId, 'created');
    const tx = buildPayTx({ payer, paymentId });
    return { xdr: tx.toXDR(), validUntil: Number(tx.timeBounds?.maxTime ?? 0) };
  }

  async submitTransaction(tx: Transaction) {
    this.guard('submit');
    const invoke = (tx.operations[0] as { func: xdr.HostFunction }).func.invokeContract();
    const [payerArg, idArg] = invoke.args() as [xdr.ScVal, xdr.ScVal];
    const id = Buffer.from(idArg.bytes()).toString('hex');
    const payer = Address.fromScVal(payerArg).toString();
    this.pay(id, payer);
    return { txHash: tx.hash().toString('hex') };
  }

  async getPayment(id: string) {
    if (this.rpcDown) throw new RpcUnavailableError();
    const p = this.payments.get(id);
    if (!p) return null;
    const { id: _id, ...rest } = p;
    return { ...rest };
  }

  async getEvents(from: { cursor: string } | { startLedger: number }, limit: number): Promise<EventsPage> {
    if (this.rpcDown) throw new RpcUnavailableError();
    const startIdx =
      'cursor' in from
        ? this.events.findIndex((e) => e.id > from.cursor)
        : this.events.findIndex((e) => e.ledger >= from.startLedger);
    const slice = startIdx === -1 ? [] : this.events.slice(startIdx, startIdx + limit);
    const last = slice[slice.length - 1];
    const cursor = last ? last.id : 'cursor' in from ? from.cursor : `${String(this.ledger).padStart(19, '0')}-9999999999`;
    return { events: slice, cursor, latestLedger: this.ledger, oldestLedger: 1 };
  }

  async getLatestLedger() {
    return this.ledger;
  }
}

/** Builds a `pay` transaction offline (source = payer, 5 minute validity). */
export function buildPayTx(opts: {
  payer: string;
  paymentId: string;
  contractId?: string;
  fn?: string;
  args?: xdr.ScVal[];
  extraOps?: number;
  fee?: string;
  timeoutSec?: number;
  source?: string;
}): Transaction {
  const source = opts.source ?? opts.payer;
  const builder = new TransactionBuilder(new Account(source, '100'), {
    fee: opts.fee ?? '100000',
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  const contract = new Contract(opts.contractId ?? CONTRACT_ID);
  const args = opts.args ?? [addressToScVal(opts.payer), paymentIdToScVal(opts.paymentId)];
  for (let i = 0; i <= (opts.extraOps ?? 0); i++) {
    builder.addOperation(contract.call(opts.fn ?? 'pay', ...args));
  }
  return builder.setTimeout(opts.timeoutSec ?? 300).build();
}

// ------------------------------------------------------------------- harness

export interface Harness {
  config: Config;
  db: Db;
  chain: FakeChain;
  logger: Logger;
  logs: string[];
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(overrides);
  const { db, close } = await createTestDb();
  const chain = new FakeChain();
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ level: 'trace' }, sink);
  // Webhook URLs in tests use example domains; resolve them to a public test IP.
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const app = createApp({ config, db, chain, logger, resolver });
  return { config, db, chain, logger, logs, app, close };
}

export async function seedMerchant(
  db: Db,
  opts: { name?: string; scopes?: Scope[] } = {},
): Promise<{ merchant: repo.MerchantRow; key: string; auth: { Authorization: string } }> {
  const merchant = await repo.insertMerchant(db, {
    name: opts.name ?? `m-${randomBytes(4).toString('hex')}`,
    displayName: 'Test Store',
    payoutAddress: Keypair.random().publicKey(),
  });
  const { key, prefix, hash } = generateApiKey(TEST_PEPPER);
  await repo.insertApiKey(db, { merchantId: merchant.id, prefix, hash, scopes: opts.scopes ?? [...SCOPES] });
  return { merchant, key, auth: { Authorization: `Bearer ${key}` } };
}

export const idem = () => ({ 'Idempotency-Key': `test-${randomBytes(8).toString('hex')}` });

export type { SettleMode };
