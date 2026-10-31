import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import * as repo from '../db/repo.js';
import { chainEvents } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { applyChainStatus, applyChainStatusTx, markFailed, onChainMatches, type PaymentPatch } from '../payments/service.js';
import { type ChainClient, type ChainEvent, EventsOutOfRetentionError } from '../stellar/chain.js';
import { type DecodedEvent, type DecodeResult, decodeEvent, eventToJson, statusForEvent } from '../stellar/contract.js';

export const CURSOR_KEY = 'payments_contract_events';

export interface IndexerDeps {
  config: Config;
  db: Db;
  chain: ChainClient;
  logger: Logger;
}

export interface BatchResult {
  fetched: number;
  inserted: number;
  applied: number;
  skipped: number;
  cursor: string;
}

/** RPC event ids look like `<toid>-<index>`; the suffix is the event index within the operation. */
export function eventIndexOf(rpcEventId: string): number {
  const n = Number(rpcEventId.split('-')[1]);
  return Number.isInteger(n) ? n : 0;
}

function patchFor(e: DecodedEvent, txHash: string): PaymentPatch {
  switch (e.name) {
    case 'created':
      return { createTxHash: txHash };
    case 'paid':
      return { payer: e.payer, payTxHash: txHash, feeBps: e.feeBps };
    case 'settled':
      return { settleTxHash: txHash, fee: e.fee.toString() };
    case 'refunded':
      return { refundTxHash: txHash };
    case 'cancelled':
      return { cancelTxHash: txHash };
    default:
      return {};
  }
}

/** Rejects events that disagree with what we created (never trust, always verify). */
function consistent(e: DecodedEvent, p: repo.PaymentRow, operator: string): boolean {
  if (e.name === 'created') {
    return (
      e.operator === operator &&
      e.amount.toString() === p.amount &&
      e.merchant === p.merchantAddress &&
      e.token === p.token &&
      e.reference === p.referenceHash
    );
  }
  if (e.name === 'paid' || e.name === 'refunded') return e.amount.toString() === p.amount;
  if (e.name === 'settled') return (e.merchantAmount + e.fee).toString() === p.amount && e.merchant === p.merchantAddress;
  return true;
}

/**
 * Fetches one page of contract events from the persisted cursor and, in ONE
 * database transaction: inserts them into `chain_events` (unique on
 * (tx hash, event index), so replays are no-ops), applies status changes
 * through the monotonic state machine (which also enqueues webhooks), and
 * advances the cursor. A crash mid-batch rolls everything back, and the next
 * run re-reads the same page.
 */
export async function runIndexerBatch(deps: IndexerDeps, limit = 200): Promise<BatchResult> {
  const { db, chain, logger, config } = deps;
  const state = await repo.getIndexerState(db, CURSOR_KEY);
  let page;
  try {
    if (state) {
      page = await chain.getEvents({ cursor: state.cursor }, limit);
    } else {
      const latest = await chain.getLatestLedger();
      const start = config.INDEXER_START_LEDGER > 0 ? config.INDEXER_START_LEDGER : Math.max(1, latest - 1000);
      page = await chain.getEvents({ startLedger: start }, limit);
    }
  } catch (err) {
    if (err instanceof EventsOutOfRetentionError) {
      // Downtime longer than RPC retention: restart near the tip; the
      // reconciler repairs anything missed from contract state.
      const latest = await chain.getLatestLedger();
      logger.warn({ latest }, 'indexer cursor outside RPC retention; restarting near tip (reconciler covers the gap)');
      page = await chain.getEvents({ startLedger: Math.max(1, latest - 100) }, limit);
    } else {
      throw err;
    }
  }

  const result: BatchResult = { fetched: page.events.length, inserted: 0, applied: 0, skipped: 0, cursor: page.cursor };
  const rows = page.events
    .filter((ev) => !ev.contractId || ev.contractId === config.PAY_CONTRACT_ID)
    .map((ev) => ({ ev, decoded: decodeEvent(ev.topics, ev.value) }));

  await db.transaction(async (tx) => {
    // 1) Record raw events in bulk; the unique (tx_hash, event_index) index makes replays no-ops.
    const fresh = new Set<string>();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const inserted = await tx
        .insert(chainEvents)
        .values(chunk.map(({ ev, decoded }) => chainEventRow(config, ev, decoded)))
        .onConflictDoNothing()
        .returning({ rpcEventId: chainEvents.rpcEventId });
      for (const r of inserted) fresh.add(r.rpcEventId);
    }
    result.inserted = fresh.size;

    // 2) Apply lifecycle changes for newly seen events, in chain order.
    const endpointCache: repo.EndpointCache = new Map();
    for (const { ev, decoded } of rows) {
      if (!fresh.has(ev.id)) continue;
      if (decoded.kind === 'unknown') {
        logger.warn({ rpcEventId: ev.id, reason: decoded.reason, name: decoded.name }, 'skipping undecodable contract event');
        result.skipped++;
        continue;
      }
      const status = statusForEvent(decoded.event);
      if (!status || !('paymentId' in decoded.event)) continue;
      const event = decoded.event;
      let inconsistent = false;
      const res = await applyChainStatusTx(tx, config, event.paymentId, status, patchFor(event, ev.txHash), {
        endpointCache,
        guard: (row) => {
          inconsistent = !consistent(event, row, chain.operatorAddress);
          return !inconsistent;
        },
      });
      if (inconsistent) {
        logger.error({ paymentId: event.paymentId, rpcEventId: ev.id }, 'chain event does not match payment record; not applied');
        result.skipped++;
      } else if (res.changed) {
        result.applied++;
      }
      // res.payment undefined: created by another operator on the same contract.
    }
    await repo.setIndexerState(tx, CURSOR_KEY, page.cursor, page.latestLedger);
  });
  if (result.fetched > 0) logger.info(result, 'indexer batch');
  return result;
}

const INSERT_CHUNK = 500;

function chainEventRow(config: Config, ev: ChainEvent, decoded: DecodeResult) {
  return {
    rpcEventId: ev.id,
    ledger: ev.ledger,
    txHash: ev.txHash,
    eventIndex: eventIndexOf(ev.id),
    contractId: config.PAY_CONTRACT_ID,
    type: decoded.kind === 'event' ? decoded.event.name : 'unknown',
    paymentId: decoded.kind === 'event' && 'paymentId' in decoded.event ? decoded.event.paymentId : null,
    payload: decoded.kind === 'event' ? eventToJson(decoded.event) : { reason: decoded.reason, name: decoded.name ?? null },
  };
}

export interface ReconcileResult {
  checked: number;
  repaired: number;
  failed: number;
}

/**
 * Compares stale non-terminal payments with `get_payment` on-chain and
 * repairs the database. Covers missed events (RPC retention gaps, downtime)
 * and creates whose outcome was unknown.
 */
export async function runReconciler(deps: IndexerDeps, limit = 50): Promise<ReconcileResult> {
  const { db, chain, logger, config } = deps;
  const now = new Date();
  const stale = await repo.listStalePayments(db, new Date(now.getTime() - config.RECONCILE_AFTER_MS), limit);
  const out: ReconcileResult = { checked: 0, repaired: 0, failed: 0 };
  for (const p of stale) {
    out.checked++;
    try {
      const found = await chain.getPayment(p.id);
      const onChain = found && onChainMatches(found, p, chain.operatorAddress) ? found : null;
      if (found && !onChain) {
        // Someone else's record under our id (e.g. a front-run create).
        logger.error({ paymentId: p.id, status: p.status }, 'on-chain payment with this id is not ours');
      }
      if (!onChain) {
        if (p.status === 'pending' && (await markFailed(db, p.id))) {
          out.failed++;
          logger.warn({ paymentId: p.id }, 'pending payment not found on-chain; marked failed');
        } else if (p.status !== 'pending') {
          logger.error({ paymentId: p.id, status: p.status }, 'payment missing on-chain (archived entry or testnet reset?)');
        }
      } else {
        const res = await applyChainStatus(db, config, p.id, onChain.status, {
          payer: onChain.payer ?? undefined,
          feeBps: onChain.paidAt !== null ? onChain.feeBps : undefined,
        });
        if (res.changed) {
          out.repaired++;
          logger.info({ paymentId: p.id, from: p.status, to: onChain.status }, 'reconciler repaired payment');
        }
      }
      await repo.markPaymentChecked(db, p.id, now);
    } catch (err) {
      logger.warn({ paymentId: p.id, err: (err as Error).message }, 'reconcile check failed');
    }
  }
  return out;
}
