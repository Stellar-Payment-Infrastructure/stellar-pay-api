import { createHash, randomBytes } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import * as repo from '../db/repo.js';
import type { MerchantRow, PaymentRow } from '../db/repo.js';
import type { PaymentStatus } from '../db/schema.js';
import { ApiError, ChainTimeoutError, conflict, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ChainClient } from '../stellar/chain.js';
import type { OnChainPayment, SettleMode } from '../stellar/contract.js';
import { verifyPayTransaction } from '../stellar/verifyPayTx.js';
import { canTransition, type ChainStatus, eventsForTransition, type WebhookEventType } from './stateMachine.js';

export interface Deps {
  config: Config;
  db: Db;
  chain: ChainClient;
  logger: Logger;
}

// ----------------------------------------------------------------- resources

export interface PaymentResource {
  id: string;
  object: 'payment';
  status: PaymentStatus;
  amount: string;
  token: string;
  tokenCode: string;
  decimals: number;
  merchantId: string;
  merchantAddress: string;
  settleMode: SettleMode;
  payer: string | null;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  successUrl: string | null;
  cancelUrl: string | null;
  feeBps: number | null;
  fee: string | null;
  checkoutUrl: string;
  transactions: {
    create: string | null;
    pay: string | null;
    settle: string | null;
    refund: string | null;
    cancel: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export function toPaymentResource(p: PaymentRow, config: Config): PaymentResource {
  return {
    id: p.id,
    object: 'payment',
    status: p.status,
    amount: p.amount,
    token: p.token,
    tokenCode: config.PAY_TOKEN_CODE,
    decimals: config.PAY_TOKEN_DECIMALS,
    merchantId: p.merchantId,
    merchantAddress: p.merchantAddress,
    settleMode: p.settleMode,
    payer: p.payer,
    reference: p.reference,
    metadata: p.metadata ?? null,
    successUrl: p.successUrl,
    cancelUrl: p.cancelUrl,
    feeBps: p.feeBps,
    fee: p.fee,
    checkoutUrl: `${config.CHECKOUT_BASE_URL.replace(/\/$/, '')}/pay/${p.id}`,
    transactions: {
      create: p.createTxHash,
      pay: p.payTxHash,
      settle: p.settleTxHash,
      refund: p.refundTxHash,
      cancel: p.cancelTxHash,
    },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** What a payer's browser may see: no metadata, reference, payer or tx details. */
export interface PublicPaymentResource {
  id: string;
  status: PaymentStatus;
  amount: string;
  token: string;
  tokenCode: string;
  decimals: number;
  merchantName: string;
  successUrl: string | null;
  cancelUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicPayment(p: PaymentRow, merchant: MerchantRow, config: Config): PublicPaymentResource {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    token: p.token,
    tokenCode: config.PAY_TOKEN_CODE,
    decimals: config.PAY_TOKEN_DECIMALS,
    merchantName: merchant.displayName,
    successUrl: p.successUrl,
    cancelUrl: p.cancelUrl,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * True only if an on-chain record is the payment this API created: same
 * operator, merchant, amount, token and reference hash. Anyone can call
 * `create_payment` with any id under their own operator, so an on-chain record
 * with our id is not proof that it is ours.
 */
export function onChainMatches(onChain: OnChainPayment, row: PaymentRow, operator: string): boolean {
  return (
    onChain.operator === operator &&
    onChain.merchant === row.merchantAddress &&
    onChain.amount.toString() === row.amount &&
    onChain.token === row.token &&
    onChain.reference === row.referenceHash
  );
}

export function newEventId(): string {
  return `evt_${randomBytes(12).toString('hex')}`;
}

export function webhookPayload(id: string, type: WebhookEventType, payment: PaymentResource): Record<string, unknown> {
  return { id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { payment } };
}

// ------------------------------------------------------- status transitions

export type PaymentPatch = Partial<
  Pick<repo.NewPaymentRow, 'payer' | 'feeBps' | 'fee' | 'createTxHash' | 'payTxHash' | 'settleTxHash' | 'refundTxHash' | 'cancelTxHash'>
>;

export interface ApplyResult {
  changed: boolean;
  payment: PaymentRow | undefined;
  events: WebhookEventType[];
}

/**
 * Moves a payment to an observed on-chain status, monotonically, and in the
 * same DB transaction records the implied webhook events and enqueues their
 * deliveries. Idempotent: re-applying the same status changes nothing (missing
 * patch fields such as tx hashes are still filled in).
 */
export interface ApplyOptions {
  /** Extra check against the locked row; returning false skips the change. */
  guard?: (row: PaymentRow) => boolean;
  /** Per-batch cache of webhook endpoint ids by merchant (indexer). */
  endpointCache?: repo.EndpointCache;
}

export async function applyChainStatus(
  db: repo.DbOrTx,
  config: Config,
  paymentId: string,
  to: ChainStatus,
  patch: PaymentPatch = {},
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  return db.transaction((tx) => applyChainStatusTx(tx, config, paymentId, to, patch, opts));
}

/** Same as `applyChainStatus` but runs inside the caller's transaction. */
export async function applyChainStatusTx(
  tx: repo.Tx,
  config: Config,
  paymentId: string,
  to: ChainStatus,
  patch: PaymentPatch = {},
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const row = await repo.findPaymentForUpdate(tx, paymentId);
  if (!row) return { changed: false, payment: undefined, events: [] };
  if (opts.guard && !opts.guard(row)) return { changed: false, payment: row, events: [] };
  if (row.status === to) {
    const fill = Object.fromEntries(
      Object.entries(patch).filter(([k, v]) => v !== undefined && row[k as keyof PaymentRow] === null),
    );
    const payment = Object.keys(fill).length > 0 ? await repo.updatePayment(tx, paymentId, fill) : row;
    return { changed: false, payment, events: [] };
  }
  if (!canTransition(row.status, to)) return { changed: false, payment: row, events: [] };

  const types = eventsForTransition(row.status, to);
  const fullPatch: PaymentPatch = { ...patch };
  const feeBps = fullPatch.feeBps ?? row.feeBps;
  if (to === 'settled' && fullPatch.fee === undefined && feeBps !== null && feeBps !== undefined) {
    // Same floor division as the contract's split_amount.
    fullPatch.fee = ((BigInt(row.amount) * BigInt(feeBps)) / 10_000n).toString();
  }
  const updated = await repo.updatePayment(tx, paymentId, { ...fullPatch, status: to });
  const resource = toPaymentResource(updated, config);
  for (const type of types) {
    const id = newEventId();
    const event = await repo.insertPaymentEvent(tx, {
      id,
      merchantId: updated.merchantId,
      paymentId,
      type,
      payload: webhookPayload(id, type, resource),
    });
    if (event) await repo.enqueueDeliveries(tx, event, opts.endpointCache);
  }
  return { changed: true, payment: updated, events: types };
}

/** `pending -> failed` for creates that never landed on-chain. */
export async function markFailed(db: Db, paymentId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await repo.findPaymentForUpdate(tx, paymentId);
    if (!row || !canTransition(row.status, 'failed')) return false;
    await repo.updatePayment(tx, paymentId, { status: 'failed' });
    return true;
  });
}

// ------------------------------------------------------------- merchant API

export interface CreatePaymentInput {
  amount: bigint;
  reference?: string;
  metadata?: Record<string, unknown>;
  settleMode: SettleMode;
  successUrl?: string;
  cancelUrl?: string;
}

export function referenceHash(paymentId: string, reference: string | undefined): string {
  return createHash('sha256')
    .update(Buffer.from(paymentId, 'hex'))
    .update(reference ?? '', 'utf8')
    .digest('hex');
}

/**
 * Creates a payment: row first (`pending`), then `create_payment` on-chain.
 * - chain call definitively fails -> row deleted, nothing persisted
 * - outcome unknown (timeout) -> row stays `pending`, returned with 202; the
 *   indexer/reconciler moves it to `created` or `failed`
 * - DB update after chain success fails -> row stays `pending`; repaired the same way
 */
export async function createPayment(
  deps: Deps,
  merchant: MerchantRow,
  input: CreatePaymentInput,
): Promise<{ payment: PaymentRow; confirmed: boolean }> {
  const { config, db, chain, logger } = deps;
  if (input.amount <= 0n || input.amount > config.maxPaymentAmount) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Amount is out of range', { max: config.maxPaymentAmount.toString() });
  }
  const id = randomBytes(32).toString('hex');
  const refHash = referenceHash(id, input.reference);
  const row = await repo.insertPayment(db, {
    id,
    merchantId: merchant.id,
    status: 'pending',
    amount: input.amount.toString(),
    token: config.PAY_TOKEN_CONTRACT_ID,
    merchantAddress: merchant.payoutAddress,
    settleMode: input.settleMode,
    reference: input.reference ?? null,
    referenceHash: refHash,
    metadata: input.metadata ?? null,
    successUrl: input.successUrl ?? null,
    cancelUrl: input.cancelUrl ?? null,
  });

  let txHash: string;
  try {
    ({ txHash } = await chain.createPayment({
      paymentId: id,
      merchant: merchant.payoutAddress,
      amount: input.amount,
      referenceHash: refHash,
      settleMode: input.settleMode,
    }));
  } catch (err) {
    if (err instanceof ChainTimeoutError) {
      logger.warn({ paymentId: id, txHash: err.txHash }, 'create_payment outcome unknown; left pending');
      return { payment: await repo.updatePayment(db, id, { createTxHash: err.txHash }), confirmed: false };
    }
    await repo.deletePayment(db, id);
    throw err;
  }

  try {
    const res = await applyChainStatus(db, config, id, 'created', { createTxHash: txHash });
    return { payment: res.payment ?? row, confirmed: true };
  } catch (err) {
    logger.error({ paymentId: id, txHash, err: (err as Error).message }, 'persist after create_payment failed; reconciler will repair');
    return { payment: row, confirmed: false };
  }
}

export async function getMerchantPayment(db: Db, merchant: MerchantRow, id: string): Promise<PaymentRow> {
  const p = await repo.findPayment(db, id);
  if (!p || p.merchantId !== merchant.id) throw notFound('Payment');
  return p;
}

type OperatorAction = 'settle' | 'cancel' | 'refund';
const ACTION_RULES: Record<OperatorAction, { from: PaymentStatus; to: ChainStatus; hashField: keyof PaymentPatch }> = {
  settle: { from: 'paid', to: 'settled', hashField: 'settleTxHash' },
  cancel: { from: 'created', to: 'cancelled', hashField: 'cancelTxHash' },
  refund: { from: 'paid', to: 'refunded', hashField: 'refundTxHash' },
};

export async function operatorAction(deps: Deps, merchant: MerchantRow, id: string, action: OperatorAction): Promise<PaymentRow> {
  const rule = ACTION_RULES[action];
  const p = await getMerchantPayment(deps.db, merchant, id);
  if (p.status !== rule.from) {
    throw conflict('INVALID_PAYMENT_STATE', `Payment cannot be ${action === 'cancel' ? 'cancelled' : `${action}d`} from status ${p.status}`, {
      status: p.status,
    });
  }
  const { txHash } = await deps.chain[action](id);
  const res = await applyChainStatus(deps.db, deps.config, id, rule.to, { [rule.hashField]: txHash });
  return res.payment ?? p;
}

// --------------------------------------------------------------- public API

export async function getPublicPayment(deps: Deps, id: string) {
  const p = await repo.findPayment(deps.db, id);
  if (!p || p.status === 'pending' || p.status === 'failed') throw notFound('Payment');
  const merchant = await repo.findMerchant(deps.db, p.merchantId);
  if (!merchant) throw notFound('Payment');
  return toPublicPayment(p, merchant, deps.config);
}

async function payablePayment(deps: Deps, id: string): Promise<PaymentRow> {
  const p = await repo.findPayment(deps.db, id);
  if (!p || p.status === 'pending' || p.status === 'failed') throw notFound('Payment');
  if (p.status !== 'created') {
    throw conflict('PAYMENT_NOT_PAYABLE', 'Payment is not awaiting payment', { status: p.status });
  }
  return p;
}

export async function buildPayTransaction(deps: Deps, id: string, payer: string) {
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    throw new ApiError(400, 'INVALID_PAYER', 'payer must be a G... account address');
  }
  const row = await payablePayment(deps, id);
  // Before a payer signs anything, prove the on-chain record is ours and payable.
  const onChain = await deps.chain.getPayment(id);
  if (!onChain || !onChainMatches(onChain, row, deps.chain.operatorAddress) || onChain.status !== 'created') {
    deps.logger.error({ paymentId: id, found: !!onChain }, 'on-chain payment does not match the record; refusing to build pay');
    throw conflict('PAYMENT_STATE_MISMATCH', 'Payment cannot be paid right now');
  }
  const { xdr, validUntil } = await deps.chain.buildPayTransaction(payer, id);
  return {
    transactionXdr: xdr,
    networkPassphrase: deps.chain.networkPassphrase,
    validUntil: new Date(validUntil * 1000).toISOString(),
  };
}

export async function submitPayTransaction(deps: Deps, id: string, signedXdr: string) {
  const row = await payablePayment(deps, id);
  const verified = verifyPayTransaction(signedXdr, {
    contractId: deps.chain.contractId,
    paymentId: id,
    networkPassphrase: deps.chain.networkPassphrase,
    maxFee: deps.config.MAX_PAY_TX_FEE,
  });
  const { txHash } = await deps.chain.submitTransaction(verified.tx);

  // Fast path: read the on-chain state now; the indexer converges anyway.
  let status: PaymentStatus = 'created';
  try {
    const onChain = await deps.chain.getPayment(id);
    if (onChain && onChainMatches(onChain, row, deps.chain.operatorAddress)) {
      const res = await applyChainStatus(deps.db, deps.config, id, onChain.status, {
        payer: onChain.payer ?? verified.payer,
        payTxHash: txHash,
        feeBps: onChain.feeBps,
      });
      status = res.payment?.status ?? onChain.status;
    }
  } catch (err) {
    deps.logger.warn({ paymentId: id, txHash, err: (err as Error).message }, 'post-submit read failed; indexer will update');
  }
  return { transactionHash: txHash, status };
}
