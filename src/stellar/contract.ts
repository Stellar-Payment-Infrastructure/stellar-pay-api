/**
 * Typed mirror of the stellar-pay-core contract interface (v0.1.0): argument
 * encoding, `get_payment` decoding and event decoding.
 *
 * The playbook's generated-bindings path (`stellar contract bindings
 * typescript`, run by scripts/sync-bindings.sh) needs the Stellar CLI. Until
 * those bindings are committed under src/generated/, this module is the
 * binding layer, and `src/generated/contract-test-vectors.json` (copied from
 * stellar-pay-core/docs/test-vectors.json) is the compatibility contract that
 * the decoder tests run against.
 */
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ChainStatus } from '../payments/stateMachine.js';

export const CONTRACT_STATUS: readonly ChainStatus[] = ['created', 'paid', 'settled', 'refunded', 'cancelled'];
export type SettleMode = 'auto' | 'manual';
const SETTLE_MODES: readonly SettleMode[] = ['auto', 'manual'];
export const SUPPORTED_EVENT_VERSION = 1;

export const PAYMENT_ID_RE = /^[0-9a-f]{64}$/;

export function paymentIdToScVal(id: string): xdr.ScVal {
  if (!PAYMENT_ID_RE.test(id)) throw new Error('payment id must be 32 bytes of lowercase hex');
  return xdr.ScVal.scvBytes(Buffer.from(id, 'hex'));
}

export function bytes32ToScVal(hex: string): xdr.ScVal {
  return paymentIdToScVal(hex);
}

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function i128ToScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: 'i128' });
}

export function settleModeToScVal(mode: SettleMode): xdr.ScVal {
  return xdr.ScVal.scvU32(mode === 'auto' ? 0 : 1);
}

export interface OnChainPayment {
  operator: string;
  merchant: string;
  payer: string | null;
  token: string;
  amount: bigint;
  feeBps: number;
  feeRecipient: string | null;
  reference: string;
  settleMode: SettleMode;
  status: ChainStatus;
  createdAt: number;
  paidAt: number | null;
  closedAt: number | null;
  version: number;
}

type NativeMap = Record<string, unknown>;

function hexOf(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  throw new Error('expected bytes');
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected address string');
  return v;
}

function optStr(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

function bigintOf(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new Error('expected integer');
}

function numOf(v: unknown): number {
  return Number(bigintOf(v));
}

function optNum(v: unknown): number | null {
  return v === null || v === undefined ? null : numOf(v);
}

function enumOf<T>(values: readonly T[], v: unknown): T {
  const out = values[numOf(v)];
  if (out === undefined) throw new Error('unknown enum value');
  return out;
}

/** Decodes the `Payment` struct returned by `get_payment`. */
export function decodePayment(scv: xdr.ScVal): OnChainPayment {
  const m = scValToNative(scv) as NativeMap;
  return {
    operator: str(m['operator']),
    merchant: str(m['merchant']),
    payer: optStr(m['payer']),
    token: str(m['token']),
    amount: bigintOf(m['amount']),
    feeBps: numOf(m['fee_bps']),
    feeRecipient: optStr(m['fee_recipient']),
    reference: hexOf(m['reference']),
    settleMode: enumOf(SETTLE_MODES, m['settle_mode']),
    status: enumOf(CONTRACT_STATUS, m['status']),
    createdAt: numOf(m['created_at']),
    paidAt: optNum(m['paid_at']),
    closedAt: optNum(m['closed_at']),
    version: numOf(m['version']),
  };
}

export type DecodedEvent =
  | { name: 'created'; v: number; paymentId: string; operator: string; merchant: string; token: string; amount: bigint; reference: string; settleMode: SettleMode; at: number }
  | { name: 'paid'; v: number; paymentId: string; payer: string; amount: bigint; feeBps: number; at: number }
  | { name: 'settled'; v: number; paymentId: string; merchant: string; feeRecipient: string; merchantAmount: bigint; fee: bigint; at: number }
  | { name: 'refunded'; v: number; paymentId: string; payer: string; amount: bigint; reason: 'operator' | 'reclaim'; at: number }
  | { name: 'cancelled'; v: number; paymentId: string; at: number }
  | { name: 'initialized' | 'fee_changed' | 'paused' | 'admin_changed'; v: number; data: NativeMap };

export type DecodeResult =
  | { kind: 'event'; event: DecodedEvent }
  | { kind: 'unknown'; reason: string; name?: string };

const ADMIN_EVENTS = new Set(['initialized', 'fee_changed', 'paused', 'admin_changed']);

/**
 * Decodes one contract event. Never throws: unknown names, versions or
 * malformed data come back as `{ kind: 'unknown' }` so the indexer can log and
 * skip them.
 */
export function decodeEvent(topics: xdr.ScVal[], value: xdr.ScVal): DecodeResult {
  try {
    if (topics.length !== 2) return { kind: 'unknown', reason: 'unexpected topic count' };
    const ns = scValToNative(topics[0] as xdr.ScVal);
    const name = scValToNative(topics[1] as xdr.ScVal);
    if (ns !== 'pay' || typeof name !== 'string') return { kind: 'unknown', reason: 'foreign topic' };
    const d = scValToNative(value) as NativeMap;
    const v = numOf(d['v']);
    if (v !== SUPPORTED_EVENT_VERSION) return { kind: 'unknown', reason: `unsupported event version ${v}`, name };
    switch (name) {
      case 'created':
        return {
          kind: 'event',
          event: {
            name, v,
            paymentId: hexOf(d['payment_id']),
            operator: str(d['operator']),
            merchant: str(d['merchant']),
            token: str(d['token']),
            amount: bigintOf(d['amount']),
            reference: hexOf(d['reference']),
            settleMode: enumOf(SETTLE_MODES, d['settle_mode']),
            at: numOf(d['created_at']),
          },
        };
      case 'paid':
        return {
          kind: 'event',
          event: {
            name, v,
            paymentId: hexOf(d['payment_id']),
            payer: str(d['payer']),
            amount: bigintOf(d['amount']),
            feeBps: numOf(d['fee_bps']),
            at: numOf(d['paid_at']),
          },
        };
      case 'settled':
        return {
          kind: 'event',
          event: {
            name, v,
            paymentId: hexOf(d['payment_id']),
            merchant: str(d['merchant']),
            feeRecipient: str(d['fee_recipient']),
            merchantAmount: bigintOf(d['merchant_amount']),
            fee: bigintOf(d['fee']),
            at: numOf(d['settled_at']),
          },
        };
      case 'refunded':
        return {
          kind: 'event',
          event: {
            name, v,
            paymentId: hexOf(d['payment_id']),
            payer: str(d['payer']),
            amount: bigintOf(d['amount']),
            reason: enumOf(['operator', 'reclaim'] as const, d['reason']),
            at: numOf(d['refunded_at']),
          },
        };
      case 'cancelled':
        return { kind: 'event', event: { name, v, paymentId: hexOf(d['payment_id']), at: numOf(d['cancelled_at']) } };
      default:
        if (ADMIN_EVENTS.has(name)) {
          return { kind: 'event', event: { name: name as 'initialized', v, data: d } };
        }
        return { kind: 'unknown', reason: 'unknown event name', name };
    }
  } catch (err) {
    return { kind: 'unknown', reason: `malformed event: ${(err as Error).message}` };
  }
}

/** Status a lifecycle event moves its payment to. */
export function statusForEvent(e: DecodedEvent): ChainStatus | null {
  switch (e.name) {
    case 'created':
    case 'paid':
    case 'settled':
    case 'refunded':
    case 'cancelled':
      return e.name;
    default:
      return null;
  }
}

/** JSON-safe form of a decoded event (bigints as decimal strings). */
export function eventToJson(e: DecodedEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Record<string, unknown>;
}
