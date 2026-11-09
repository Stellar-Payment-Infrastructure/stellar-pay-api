import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDB5PL5RITGAI6FBYTICPZMQIFROZEMXYMSKFGVK5NOUEX2XLYQ3IS4I",
  }
} as const

/**
 * Contract error codes. The numeric values are part of the public interface:
 * the API maps `Error(Contract, #N)` to stable error codes, so never renumber.
 */
export const Errors = {
  /**
   * `initialize` has not been called yet.
   */
  1: {message:"NotInitialized"},
  /**
   * `initialize` was already called.
   */
  2: {message:"AlreadyInitialized"},
  /**
   * No payment (or pending admin) exists for the given key.
   */
  3: {message:"NotFound"},
  /**
   * A payment with this id already exists.
   */
  4: {message:"AlreadyExists"},
  /**
   * The caller is not allowed to perform this action.
   */
  5: {message:"Unauthorized"},
  /**
   * Amount must be strictly positive.
   */
  6: {message:"InvalidAmount"},
  /**
   * The payment is not in a state that allows this transition.
   */
  7: {message:"InvalidState"},
  /**
   * The contract is paused (blocks `create_payment` and `pay` only).
   */
  8: {message:"Paused"},
  /**
   * The token is not accepted by this deployment.
   */
  9: {message:"TokenNotAllowed"},
  /**
   * `fee_bps` exceeds `MAX_FEE_BPS`.
   */
  10: {message:"FeeTooHigh"},
  /**
   * `reclaim` called before `paid_at + reclaim_delay`.
   */
  11: {message:"TooEarly"},
  /**
   * Checked arithmetic overflowed.
   */
  12: {message:"Overflow"},
  /**
   * An address argument is not allowed here (e.g. the contract itself).
   */
  13: {message:"InvalidAddress"},
  /**
   * `reclaim_delay` is outside `MIN_RECLAIM_DELAY..=MAX_RECLAIM_DELAY`.
   */
  14: {message:"InvalidDelay"}
}


/**
 * Deployment-wide configuration (instance storage).
 */
export interface Config {
  admin: string;
  fee_bps: u32;
  fee_recipient: string;
  paused: boolean;
  /**
 * Seconds after `paid_at` before the payer may `reclaim`.
 */
reclaim_delay: u64;
  /**
 * The single token accepted by this deployment (SEP-41 / SAC address).
 */
token: string;
  /**
 * Incremented on every config change.
 */
version: u32;
}

/**
 * Payment lifecycle state. Transitions are one-way:
 * `Created -> Paid -> Settled | Refunded`, `Created -> Cancelled`.
 */
export enum Status {
  Created = 0,
  Paid = 1,
  Settled = 2,
  Refunded = 3,
  Cancelled = 4,
}

/**
 * Storage keys.
 * 
 * `Config` and `PendingAdmin` live in instance storage; `Payment` entries live
 * in persistent storage (never temporary: they hold money state).
 */
export type DataKey = {tag: "Config", values: void} | {tag: "Payment", values: readonly [Buffer]} | {tag: "PendingAdmin", values: void};


/**
 * A payment record (persistent storage). Contains no PII: only addresses,
 * amounts, a 32-byte opaque reference hash, status and ledger timestamps.
 */
export interface Payment {
  amount: i128;
  closed_at: Option<u64>;
  condition: Condition;
  created_at: u64;
  /**
 * Copied from config at create and fixed for the life of the payment.
 */
fee_bps: u32;
  /**
 * Snapshotted at `pay` so later config changes don't affect in-flight payments.
 */
fee_recipient: Option<string>;
  /**
 * Payee: receives `amount - fee` on settle.
 */
merchant: string;
  /**
 * Authorizes lifecycle actions (create, settle, cancel, refund).
 */
operator: string;
  paid_at: Option<u64>;
  /**
 * Set by `pay`.
 */
payer: Option<string>;
  /**
 * Opaque merchant reference hash (never raw order data).
 */
reference: Buffer;
  settle_mode: SettleMode;
  status: Status;
  token: string;
  /**
 * Storage schema version of this record.
 */
version: u32;
}

/**
 * Extension point for conditional payments (time-lock, hash-lock).
 * Only `None` exists in v1 so new variants can be added without breaking
 * the storage layout.
 */
export enum Condition {
  None = 0,
}

/**
 * `Auto` settles inside `pay` (funds are never escrowed); `Manual` escrows
 * funds until the operator calls `settle` or `refund`.
 */
export enum SettleMode {
  Auto = 0,
  Manual = 1,
}

/**
 * Why a payment moved to `Refunded`.
 */
export enum RefundReason {
  Operator = 0,
  Reclaim = 1,
}


export interface PaidEvent {
  amount: i128;
  fee_bps: u32;
  paid_at: u64;
  payer: string;
  payment_id: Buffer;
  v: u32;
}


export interface PausedEvent {
  config_version: u32;
  paused: boolean;
  v: u32;
}


export interface CreatedEvent {
  amount: i128;
  created_at: u64;
  merchant: string;
  operator: string;
  payment_id: Buffer;
  reference: Buffer;
  settle_mode: SettleMode;
  token: string;
  v: u32;
}


export interface SettledEvent {
  fee: i128;
  fee_recipient: string;
  merchant: string;
  merchant_amount: i128;
  payment_id: Buffer;
  settled_at: u64;
  v: u32;
}


export interface RefundedEvent {
  amount: i128;
  payer: string;
  payment_id: Buffer;
  reason: RefundReason;
  refunded_at: u64;
  v: u32;
}


export interface CancelledEvent {
  cancelled_at: u64;
  payment_id: Buffer;
  v: u32;
}


export interface FeeChangedEvent {
  config_version: u32;
  fee_bps: u32;
  fee_recipient: string;
  v: u32;
}


export interface InitializedEvent {
  admin: string;
  fee_bps: u32;
  fee_recipient: string;
  reclaim_delay: u64;
  token: string;
  v: u32;
}


export interface AdminChangedEvent {
  admin: string;
  config_version: u32;
  previous_admin: string;
  v: u32;
}

export interface Client {
  /**
   * Construct and simulate a pay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays a `Created` payment. Requires `payer` auth (which must cover the
   * nested token transfer). Snapshots the current fee bps and fee
   * recipient into the payment.
   * 
   * `Manual`: moves `amount` from the payer into contract escrow (`Paid`).
   * `Auto`: transfers `amount - fee` to the merchant and `fee` to the fee
   * recipient directly from the payer (`Settled`); funds are never held.
   * Not allowed while paused.
   */
  pay: ({payer, payment_id}: {payer: string, payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels a `Created` payment. Requires the payment's operator auth.
   */
  cancel: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Refunds a `Paid` payment: returns the full `amount` to the payer.
   * Requires the payment's operator auth. Allowed while paused.
   */
  refund: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settles a `Paid` payment: `amount - fee` to the merchant and `fee` to
   * the fee recipient snapshotted at `create_payment`. Requires the payment's
   * operator auth. Allowed while paused.
   */
  settle: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reclaim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Payer safety valve: refunds a `Paid` payment to its payer once
   * `paid_at + reclaim_delay` has passed (ledger time). Requires the
   * payer's auth. Allowed while paused.
   */
  reclaim: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Updates the fee (capped at `MAX_FEE_BPS`) and fee recipient. Requires
   * admin auth. Does not affect payments that are already paid.
   */
  set_fee: ({fee_bps, fee_recipient}: {fee_bps: u32, fee_recipient: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a bump_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extends the TTL of a payment entry (and the contract instance).
   * Permissionless: anyone may pay the rent.
   */
  bump_ttl: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the deployment configuration. Read-only.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Config>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time setup. Requires `admin` auth. Fails with `AlreadyInitialized`
   * if called twice, `FeeTooHigh` if `fee_bps > MAX_FEE_BPS`, and
   * `InvalidAddress` if `token` or `fee_recipient` is this contract.
   */
  initialize: ({admin, token, fee_bps, fee_recipient, reclaim_delay}: {admin: string, token: string, fee_bps: u32, fee_recipient: string, reclaim_delay: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauses or unpauses the contract. Requires admin auth. Pausing blocks
   * only `create_payment` and `pay`; funds can always leave escrow.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns a payment. Read-only.
   */
  get_payment: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Payment>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Step 2 of the admin transfer: the pending admin accepts. Requires the
   * pending admin's auth. Fails with `NotFound` if nothing is pending.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Step 1 of the admin transfer: records `new_admin` as pending.
   * Requires current admin auth. A later call replaces the pending admin.
   */
  propose_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a payment in `Created`. Requires `operator` auth.
   * 
   * `payment_id` is a caller-chosen unique 32-byte id (duplicate ids fail
   * with `AlreadyExists`, which makes creation idempotent per id).
   * `amount` is in token base units and must be > 0. `reference` is an
   * opaque 32-byte hash (never raw order data). Not allowed while paused.
   */
  create_payment: ({operator, merchant, payment_id, amount, reference, settle_mode}: {operator: string, merchant: string, payment_id: Buffer, amount: i128, reference: Buffer, settle_mode: SettleMode}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAYxQYXlzIGEgYENyZWF0ZWRgIHBheW1lbnQuIFJlcXVpcmVzIGBwYXllcmAgYXV0aCAod2hpY2ggbXVzdCBjb3ZlciB0aGUKbmVzdGVkIHRva2VuIHRyYW5zZmVyKS4gU25hcHNob3RzIHRoZSBjdXJyZW50IGZlZSBicHMgYW5kIGZlZQpyZWNpcGllbnQgaW50byB0aGUgcGF5bWVudC4KCmBNYW51YWxgOiBtb3ZlcyBgYW1vdW50YCBmcm9tIHRoZSBwYXllciBpbnRvIGNvbnRyYWN0IGVzY3JvdyAoYFBhaWRgKS4KYEF1dG9gOiB0cmFuc2ZlcnMgYGFtb3VudCAtIGZlZWAgdG8gdGhlIG1lcmNoYW50IGFuZCBgZmVlYCB0byB0aGUgZmVlCnJlY2lwaWVudCBkaXJlY3RseSBmcm9tIHRoZSBwYXllciAoYFNldHRsZWRgKTsgZnVuZHMgYXJlIG5ldmVyIGhlbGQuCk5vdCBhbGxvd2VkIHdoaWxlIHBhdXNlZC4AAAADcGF5AAAAAAIAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAEJDYW5jZWxzIGEgYENyZWF0ZWRgIHBheW1lbnQuIFJlcXVpcmVzIHRoZSBwYXltZW50J3Mgb3BlcmF0b3IgYXV0aC4AAAAAAAZjYW5jZWwAAAAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAH1SZWZ1bmRzIGEgYFBhaWRgIHBheW1lbnQ6IHJldHVybnMgdGhlIGZ1bGwgYGFtb3VudGAgdG8gdGhlIHBheWVyLgpSZXF1aXJlcyB0aGUgcGF5bWVudCdzIG9wZXJhdG9yIGF1dGguIEFsbG93ZWQgd2hpbGUgcGF1c2VkLgAAAAAAAAZyZWZ1bmQAAAAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAALRTZXR0bGVzIGEgYFBhaWRgIHBheW1lbnQ6IGBhbW91bnQgLSBmZWVgIHRvIHRoZSBtZXJjaGFudCBhbmQgYGZlZWAgdG8KdGhlIGZlZSByZWNpcGllbnQgc25hcHNob3R0ZWQgYXQgYGNyZWF0ZV9wYXltZW50YC4gUmVxdWlyZXMgdGhlIHBheW1lbnQncwpvcGVyYXRvciBhdXRoLiBBbGxvd2VkIHdoaWxlIHBhdXNlZC4AAAAGc2V0dGxlAAAAAAABAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAKNQYXllciBzYWZldHkgdmFsdmU6IHJlZnVuZHMgYSBgUGFpZGAgcGF5bWVudCB0byBpdHMgcGF5ZXIgb25jZQpgcGFpZF9hdCArIHJlY2xhaW1fZGVsYXlgIGhhcyBwYXNzZWQgKGxlZGdlciB0aW1lKS4gUmVxdWlyZXMgdGhlCnBheWVyJ3MgYXV0aC4gQWxsb3dlZCB3aGlsZSBwYXVzZWQuAAAAAAdyZWNsYWltAAAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAIFVcGRhdGVzIHRoZSBmZWUgKGNhcHBlZCBhdCBgTUFYX0ZFRV9CUFNgKSBhbmQgZmVlIHJlY2lwaWVudC4gUmVxdWlyZXMKYWRtaW4gYXV0aC4gRG9lcyBub3QgYWZmZWN0IHBheW1lbnRzIHRoYXQgYXJlIGFscmVhZHkgcGFpZC4AAAAAAAAHc2V0X2ZlZQAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAQAAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAGhFeHRlbmRzIHRoZSBUVEwgb2YgYSBwYXltZW50IGVudHJ5IChhbmQgdGhlIGNvbnRyYWN0IGluc3RhbmNlKS4KUGVybWlzc2lvbmxlc3M6IGFueW9uZSBtYXkgcGF5IHRoZSByZW50LgAAAAhidW1wX3R0bAAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAADBSZXR1cm5zIHRoZSBkZXBsb3ltZW50IGNvbmZpZ3VyYXRpb24uIFJlYWQtb25seS4AAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAMVPbmUtdGltZSBzZXR1cC4gUmVxdWlyZXMgYGFkbWluYCBhdXRoLiBGYWlscyB3aXRoIGBBbHJlYWR5SW5pdGlhbGl6ZWRgCmlmIGNhbGxlZCB0d2ljZSwgYEZlZVRvb0hpZ2hgIGlmIGBmZWVfYnBzID4gTUFYX0ZFRV9CUFNgLCBhbmQKYEludmFsaWRBZGRyZXNzYCBpZiBgdG9rZW5gIG9yIGBmZWVfcmVjaXBpZW50YCBpcyB0aGlzIGNvbnRyYWN0LgAAAAAAAAppbml0aWFsaXplAAAAAAAFAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAA1mZWVfcmVjaXBpZW50AAAAAAAAEwAAAAAAAAANcmVjbGFpbV9kZWxheQAAAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAIRQYXVzZXMgb3IgdW5wYXVzZXMgdGhlIGNvbnRyYWN0LiBSZXF1aXJlcyBhZG1pbiBhdXRoLiBQYXVzaW5nIGJsb2Nrcwpvbmx5IGBjcmVhdGVfcGF5bWVudGAgYW5kIGBwYXlgOyBmdW5kcyBjYW4gYWx3YXlzIGxlYXZlIGVzY3Jvdy4AAAAKc2V0X3BhdXNlZAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAB1SZXR1cm5zIGEgcGF5bWVudC4gUmVhZC1vbmx5LgAAAAAAAAtnZXRfcGF5bWVudAAAAAABAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAAdQYXltZW50AAAAAAM=",
        "AAAAAAAAAIhTdGVwIDIgb2YgdGhlIGFkbWluIHRyYW5zZmVyOiB0aGUgcGVuZGluZyBhZG1pbiBhY2NlcHRzLiBSZXF1aXJlcyB0aGUKcGVuZGluZyBhZG1pbidzIGF1dGguIEZhaWxzIHdpdGggYE5vdEZvdW5kYCBpZiBub3RoaW5nIGlzIHBlbmRpbmcuAAAADGFjY2VwdF9hZG1pbgAAAAAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAINTdGVwIDEgb2YgdGhlIGFkbWluIHRyYW5zZmVyOiByZWNvcmRzIGBuZXdfYWRtaW5gIGFzIHBlbmRpbmcuClJlcXVpcmVzIGN1cnJlbnQgYWRtaW4gYXV0aC4gQSBsYXRlciBjYWxsIHJlcGxhY2VzIHRoZSBwZW5kaW5nIGFkbWluLgAAAAANcHJvcG9zZV9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAUhDcmVhdGVzIGEgcGF5bWVudCBpbiBgQ3JlYXRlZGAuIFJlcXVpcmVzIGBvcGVyYXRvcmAgYXV0aC4KCmBwYXltZW50X2lkYCBpcyBhIGNhbGxlci1jaG9zZW4gdW5pcXVlIDMyLWJ5dGUgaWQgKGR1cGxpY2F0ZSBpZHMgZmFpbAp3aXRoIGBBbHJlYWR5RXhpc3RzYCwgd2hpY2ggbWFrZXMgY3JlYXRpb24gaWRlbXBvdGVudCBwZXIgaWQpLgpgYW1vdW50YCBpcyBpbiB0b2tlbiBiYXNlIHVuaXRzIGFuZCBtdXN0IGJlID4gMC4gYHJlZmVyZW5jZWAgaXMgYW4Kb3BhcXVlIDMyLWJ5dGUgaGFzaCAobmV2ZXIgcmF3IG9yZGVyIGRhdGEpLiBOb3QgYWxsb3dlZCB3aGlsZSBwYXVzZWQuAAAADmNyZWF0ZV9wYXltZW50AAAAAAAGAAAAAAAAAAhvcGVyYXRvcgAAABMAAAAAAAAACG1lcmNoYW50AAAAEwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAJcmVmZXJlbmNlAAAAAAAD7gAAACAAAAAAAAAAC3NldHRsZV9tb2RlAAAAB9AAAAAKU2V0dGxlTW9kZQAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAABAAAAJdDb250cmFjdCBlcnJvciBjb2Rlcy4gVGhlIG51bWVyaWMgdmFsdWVzIGFyZSBwYXJ0IG9mIHRoZSBwdWJsaWMgaW50ZXJmYWNlOgp0aGUgQVBJIG1hcHMgYEVycm9yKENvbnRyYWN0LCAjTilgIHRvIHN0YWJsZSBlcnJvciBjb2Rlcywgc28gbmV2ZXIgcmVudW1iZXIuAAAAAAAAAAAFRXJyb3IAAAAAAAAOAAAAJWBpbml0aWFsaXplYCBoYXMgbm90IGJlZW4gY2FsbGVkIHlldC4AAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAgYGluaXRpYWxpemVgIHdhcyBhbHJlYWR5IGNhbGxlZC4AAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAACAAAAN05vIHBheW1lbnQgKG9yIHBlbmRpbmcgYWRtaW4pIGV4aXN0cyBmb3IgdGhlIGdpdmVuIGtleS4AAAAACE5vdEZvdW5kAAAAAwAAACZBIHBheW1lbnQgd2l0aCB0aGlzIGlkIGFscmVhZHkgZXhpc3RzLgAAAAAADUFscmVhZHlFeGlzdHMAAAAAAAAEAAAAMVRoZSBjYWxsZXIgaXMgbm90IGFsbG93ZWQgdG8gcGVyZm9ybSB0aGlzIGFjdGlvbi4AAAAAAAAMVW5hdXRob3JpemVkAAAABQAAACFBbW91bnQgbXVzdCBiZSBzdHJpY3RseSBwb3NpdGl2ZS4AAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAYAAAA6VGhlIHBheW1lbnQgaXMgbm90IGluIGEgc3RhdGUgdGhhdCBhbGxvd3MgdGhpcyB0cmFuc2l0aW9uLgAAAAAADEludmFsaWRTdGF0ZQAAAAcAAABAVGhlIGNvbnRyYWN0IGlzIHBhdXNlZCAoYmxvY2tzIGBjcmVhdGVfcGF5bWVudGAgYW5kIGBwYXlgIG9ubHkpLgAAAAZQYXVzZWQAAAAAAAgAAAAtVGhlIHRva2VuIGlzIG5vdCBhY2NlcHRlZCBieSB0aGlzIGRlcGxveW1lbnQuAAAAAAAAD1Rva2VuTm90QWxsb3dlZAAAAAAJAAAAIGBmZWVfYnBzYCBleGNlZWRzIGBNQVhfRkVFX0JQU2AuAAAACkZlZVRvb0hpZ2gAAAAAAAoAAAAyYHJlY2xhaW1gIGNhbGxlZCBiZWZvcmUgYHBhaWRfYXQgKyByZWNsYWltX2RlbGF5YC4AAAAAAAhUb29FYXJseQAAAAsAAAAeQ2hlY2tlZCBhcml0aG1ldGljIG92ZXJmbG93ZWQuAAAAAAAIT3ZlcmZsb3cAAAAMAAAAQ0FuIGFkZHJlc3MgYXJndW1lbnQgaXMgbm90IGFsbG93ZWQgaGVyZSAoZS5nLiB0aGUgY29udHJhY3QgaXRzZWxmKS4AAAAADkludmFsaWRBZGRyZXNzAAAAAAANAAAAQ2ByZWNsYWltX2RlbGF5YCBpcyBvdXRzaWRlIGBNSU5fUkVDTEFJTV9ERUxBWS4uPU1BWF9SRUNMQUlNX0RFTEFZYC4AAAAADEludmFsaWREZWxheQAAAA4=",
        "AAAAAQAAADFEZXBsb3ltZW50LXdpZGUgY29uZmlndXJhdGlvbiAoaW5zdGFuY2Ugc3RvcmFnZSkuAAAAAAAAAAAAAAZDb25maWcAAAAAAAcAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAA1mZWVfcmVjaXBpZW50AAAAAAAAEwAAAAAAAAAGcGF1c2VkAAAAAAABAAAAN1NlY29uZHMgYWZ0ZXIgYHBhaWRfYXRgIGJlZm9yZSB0aGUgcGF5ZXIgbWF5IGByZWNsYWltYC4AAAAADXJlY2xhaW1fZGVsYXkAAAAAAAAGAAAARFRoZSBzaW5nbGUgdG9rZW4gYWNjZXB0ZWQgYnkgdGhpcyBkZXBsb3ltZW50IChTRVAtNDEgLyBTQUMgYWRkcmVzcykuAAAABXRva2VuAAAAAAAAEwAAACNJbmNyZW1lbnRlZCBvbiBldmVyeSBjb25maWcgY2hhbmdlLgAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAwAAAHJQYXltZW50IGxpZmVjeWNsZSBzdGF0ZS4gVHJhbnNpdGlvbnMgYXJlIG9uZS13YXk6CmBDcmVhdGVkIC0+IFBhaWQgLT4gU2V0dGxlZCB8IFJlZnVuZGVkYCwgYENyZWF0ZWQgLT4gQ2FuY2VsbGVkYC4AAAAAAAAAAAAGU3RhdHVzAAAAAAAFAAAAAAAAAAdDcmVhdGVkAAAAAAAAAAAAAAAABFBhaWQAAAABAAAAAAAAAAdTZXR0bGVkAAAAAAIAAAAAAAAACFJlZnVuZGVkAAAAAwAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAABA==",
        "AAAAAgAAAJtTdG9yYWdlIGtleXMuCgpgQ29uZmlnYCBhbmQgYFBlbmRpbmdBZG1pbmAgbGl2ZSBpbiBpbnN0YW5jZSBzdG9yYWdlOyBgUGF5bWVudGAgZW50cmllcyBsaXZlCmluIHBlcnNpc3RlbnQgc3RvcmFnZSAobmV2ZXIgdGVtcG9yYXJ5OiB0aGV5IGhvbGQgbW9uZXkgc3RhdGUpLgAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAAAAAAAAAAABkNvbmZpZwAAAAAAAQAAAAAAAAAHUGF5bWVudAAAAAABAAAD7gAAACAAAAAAAAAAAAAAAAxQZW5kaW5nQWRtaW4=",
        "AAAAAQAAAI9BIHBheW1lbnQgcmVjb3JkIChwZXJzaXN0ZW50IHN0b3JhZ2UpLiBDb250YWlucyBubyBQSUk6IG9ubHkgYWRkcmVzc2VzLAphbW91bnRzLCBhIDMyLWJ5dGUgb3BhcXVlIHJlZmVyZW5jZSBoYXNoLCBzdGF0dXMgYW5kIGxlZGdlciB0aW1lc3RhbXBzLgAAAAAAAAAAB1BheW1lbnQAAAAADwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAljbG9zZWRfYXQAAAAAAAPoAAAABgAAAAAAAAAJY29uZGl0aW9uAAAAAAAH0AAAAAlDb25kaXRpb24AAAAAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAABDQ29waWVkIGZyb20gY29uZmlnIGF0IGNyZWF0ZSBhbmQgZml4ZWQgZm9yIHRoZSBsaWZlIG9mIHRoZSBwYXltZW50LgAAAAAHZmVlX2JwcwAAAAAEAAAATVNuYXBzaG90dGVkIGF0IGBwYXlgIHNvIGxhdGVyIGNvbmZpZyBjaGFuZ2VzIGRvbid0IGFmZmVjdCBpbi1mbGlnaHQgcGF5bWVudHMuAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAPoAAAAEwAAAClQYXllZTogcmVjZWl2ZXMgYGFtb3VudCAtIGZlZWAgb24gc2V0dGxlLgAAAAAAAAhtZXJjaGFudAAAABMAAAA+QXV0aG9yaXplcyBsaWZlY3ljbGUgYWN0aW9ucyAoY3JlYXRlLCBzZXR0bGUsIGNhbmNlbCwgcmVmdW5kKS4AAAAAAAhvcGVyYXRvcgAAABMAAAAAAAAAB3BhaWRfYXQAAAAD6AAAAAYAAAANU2V0IGJ5IGBwYXlgLgAAAAAAAAVwYXllcgAAAAAAA+gAAAATAAAANk9wYXF1ZSBtZXJjaGFudCByZWZlcmVuY2UgaGFzaCAobmV2ZXIgcmF3IG9yZGVyIGRhdGEpLgAAAAAACXJlZmVyZW5jZQAAAAAAA+4AAAAgAAAAAAAAAAtzZXR0bGVfbW9kZQAAAAfQAAAAClNldHRsZU1vZGUAAAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAABlN0YXR1cwAAAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAmU3RvcmFnZSBzY2hlbWEgdmVyc2lvbiBvZiB0aGlzIHJlY29yZC4AAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAwAAAJtFeHRlbnNpb24gcG9pbnQgZm9yIGNvbmRpdGlvbmFsIHBheW1lbnRzICh0aW1lLWxvY2ssIGhhc2gtbG9jaykuCk9ubHkgYE5vbmVgIGV4aXN0cyBpbiB2MSBzbyBuZXcgdmFyaWFudHMgY2FuIGJlIGFkZGVkIHdpdGhvdXQgYnJlYWtpbmcKdGhlIHN0b3JhZ2UgbGF5b3V0LgAAAAAAAAAACUNvbmRpdGlvbgAAAAAAAAEAAAAAAAAABE5vbmUAAAAA",
        "AAAAAwAAAH1gQXV0b2Agc2V0dGxlcyBpbnNpZGUgYHBheWAgKGZ1bmRzIGFyZSBuZXZlciBlc2Nyb3dlZCk7IGBNYW51YWxgIGVzY3Jvd3MKZnVuZHMgdW50aWwgdGhlIG9wZXJhdG9yIGNhbGxzIGBzZXR0bGVgIG9yIGByZWZ1bmRgLgAAAAAAAAAAAAAKU2V0dGxlTW9kZQAAAAAAAgAAAAAAAAAEQXV0bwAAAAAAAAAAAAAABk1hbnVhbAAAAAAAAQ==",
        "AAAAAwAAACJXaHkgYSBwYXltZW50IG1vdmVkIHRvIGBSZWZ1bmRlZGAuAAAAAAAAAAAADFJlZnVuZFJlYXNvbgAAAAIAAAAdVGhlIG9wZXJhdG9yIGNhbGxlZCBgcmVmdW5kYC4AAAAAAAAIT3BlcmF0b3IAAAAAAAAAMVRoZSBwYXllciBjYWxsZWQgYHJlY2xhaW1gIGFmdGVyIGByZWNsYWltX2RlbGF5YC4AAAAAAAAHUmVjbGFpbQAAAAAB",
        "AAAAAQAAAAAAAAAAAAAACVBhaWRFdmVudAAAAAAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAAdwYWlkX2F0AAAAAAYAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAAAXYAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAAC1BhdXNlZEV2ZW50AAAAAAMAAAAAAAAADmNvbmZpZ192ZXJzaW9uAAAAAAAEAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAAAAAAAAXYAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADENyZWF0ZWRFdmVudAAAAAkAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAKY3JlYXRlZF9hdAAAAAAABgAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAAAAAAlyZWZlcmVuY2UAAAAAAAPuAAAAIAAAAAAAAAALc2V0dGxlX21vZGUAAAAH0AAAAApTZXR0bGVNb2RlAAAAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAABdgAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAADFNldHRsZWRFdmVudAAAAAcAAAAAAAAAA2ZlZQAAAAALAAAAAAAAAA1mZWVfcmVjaXBpZW50AAAAAAAAEwAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAAAAAA9tZXJjaGFudF9hbW91bnQAAAAACwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAACnNldHRsZWRfYXQAAAAAAAYAAAAAAAAAAXYAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADVJlZnVuZGVkRXZlbnQAAAAAAAAGAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAABnJlYXNvbgAAAAAH0AAAAAxSZWZ1bmRSZWFzb24AAAAAAAAAC3JlZnVuZGVkX2F0AAAAAAYAAAAAAAAAAXYAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAADkNhbmNlbGxlZEV2ZW50AAAAAAADAAAAAAAAAAxjYW5jZWxsZWRfYXQAAAAGAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAAAAAABdgAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAD0ZlZUNoYW5nZWRFdmVudAAAAAAEAAAAAAAAAA5jb25maWdfdmVyc2lvbgAAAAAABAAAAAAAAAAHZmVlX2JwcwAAAAAEAAAAAAAAAA1mZWVfcmVjaXBpZW50AAAAAAAAEwAAAAAAAAABdgAAAAAAAAQ=",
        "AAAAAQAAAAAAAAAAAAAAEEluaXRpYWxpemVkRXZlbnQAAAAGAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAABAAAAAAAAAANZmVlX3JlY2lwaWVudAAAAAAAABMAAAAAAAAADXJlY2xhaW1fZGVsYXkAAAAAAAAGAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAAAXYAAAAAAAAE",
        "AAAAAQAAAAAAAAAAAAAAEUFkbWluQ2hhbmdlZEV2ZW50AAAAAAAABAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAA5jb25maWdfdmVyc2lvbgAAAAAABAAAAAAAAAAOcHJldmlvdXNfYWRtaW4AAAAAABMAAAAAAAAAAXYAAAAAAAAE" ]),
      options
    )
  }
  public readonly fromJSON = {
    pay: this.txFromJSON<Result<void>>,
        cancel: this.txFromJSON<Result<void>>,
        refund: this.txFromJSON<Result<void>>,
        settle: this.txFromJSON<Result<void>>,
        reclaim: this.txFromJSON<Result<void>>,
        set_fee: this.txFromJSON<Result<void>>,
        bump_ttl: this.txFromJSON<Result<void>>,
        get_config: this.txFromJSON<Result<Config>>,
        initialize: this.txFromJSON<Result<void>>,
        set_paused: this.txFromJSON<Result<void>>,
        get_payment: this.txFromJSON<Result<Payment>>,
        accept_admin: this.txFromJSON<Result<void>>,
        propose_admin: this.txFromJSON<Result<void>>,
        create_payment: this.txFromJSON<Result<void>>
  }
}