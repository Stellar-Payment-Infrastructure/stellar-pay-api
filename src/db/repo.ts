/**
 * Data access. Every function takes the database (or a transaction) as its
 * first argument; all queries are parameterized through Drizzle.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  apiKeys,
  idempotencyKeys,
  indexerState,
  merchants,
  paymentEvents,
  payments,
  webhookDeliveries,
  webhookEndpoints,
  type PaymentStatus,
} from './schema.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export type MerchantRow = typeof merchants.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

// ------------------------------------------------------------------ merchants

export async function insertMerchant(
  db: DbOrTx,
  m: { name: string; displayName: string; payoutAddress: string },
): Promise<MerchantRow> {
  const [row] = await db.insert(merchants).values(m).returning();
  if (!row) throw new Error('insert merchant returned no row');
  return row;
}

export async function findMerchant(db: DbOrTx, id: string): Promise<MerchantRow | undefined> {
  const [row] = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
  return row;
}

// ------------------------------------------------------------------- api keys

export async function insertApiKey(
  db: DbOrTx,
  k: { merchantId: string; prefix: string; hash: string; scopes: string[] },
): Promise<ApiKeyRow> {
  const [row] = await db.insert(apiKeys).values(k).returning();
  if (!row) throw new Error('insert api key returned no row');
  return row;
}

export function findActiveKeysByPrefix(db: DbOrTx, prefix: string): Promise<ApiKeyRow[]> {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .limit(5);
}

export async function touchApiKey(db: DbOrTx, id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

export function listApiKeys(db: DbOrTx, merchantId: string): Promise<ApiKeyRow[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.merchantId, merchantId)).orderBy(asc(apiKeys.createdAt));
}

export async function revokeApiKey(db: DbOrTx, merchantId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, merchantId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

// ------------------------------------------------------------------- payments

export async function insertPayment(db: DbOrTx, p: NewPaymentRow): Promise<PaymentRow> {
  const [row] = await db.insert(payments).values(p).returning();
  if (!row) throw new Error('insert payment returned no row');
  return row;
}

export async function findPayment(db: DbOrTx, id: string): Promise<PaymentRow | undefined> {
  const [row] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return row;
}

export async function findPaymentForUpdate(tx: Tx, id: string): Promise<PaymentRow | undefined> {
  const [row] = await tx.select().from(payments).where(eq(payments.id, id)).for('update').limit(1);
  return row;
}

export async function updatePayment(db: DbOrTx, id: string, patch: Partial<NewPaymentRow>): Promise<PaymentRow> {
  const [row] = await db
    .update(payments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(payments.id, id))
    .returning();
  if (!row) throw new Error('payment vanished during update');
  return row;
}

export async function deletePayment(db: DbOrTx, id: string): Promise<void> {
  await db.delete(payments).where(eq(payments.id, id));
}

export interface ListPaymentsQuery {
  merchantId: string;
  status?: PaymentStatus;
  createdGte?: Date;
  createdLte?: Date;
  /** When set, results are ordered by (updatedAt, id) ascending: the aggregator feed. */
  updatedSince?: Date;
  limit: number;
  after?: { ts: Date; id: string };
}

/**
 * Keyset pagination. Default order: newest first by (createdAt, id). With
 * `updatedSince`: oldest update first by (updatedAt, id), so a consumer can
 * resume from the last row it saw without gaps.
 */
export function listPayments(db: DbOrTx, q: ListPaymentsQuery): Promise<PaymentRow[]> {
  const conds: SQL[] = [eq(payments.merchantId, q.merchantId)];
  if (q.status) conds.push(eq(payments.status, q.status));
  if (q.createdGte) conds.push(gte(payments.createdAt, q.createdGte));
  if (q.createdLte) conds.push(lte(payments.createdAt, q.createdLte));
  if (q.updatedSince) {
    conds.push(gte(payments.updatedAt, q.updatedSince));
    if (q.after) {
      conds.push(
        or(gt(payments.updatedAt, q.after.ts), and(eq(payments.updatedAt, q.after.ts), gt(payments.id, q.after.id))) as SQL,
      );
    }
    return db
      .select()
      .from(payments)
      .where(and(...conds))
      .orderBy(asc(payments.updatedAt), asc(payments.id))
      .limit(q.limit + 1);
  }
  if (q.after) {
    conds.push(
      or(lt(payments.createdAt, q.after.ts), and(eq(payments.createdAt, q.after.ts), lt(payments.id, q.after.id))) as SQL,
    );
  }
  return db
    .select()
    .from(payments)
    .where(and(...conds))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(q.limit + 1);
}

/**
 * Non-terminal payments not updated (or checked) since `before`, least
 * recently checked first, so every stale row gets its turn (reconciler input).
 */
export function listStalePayments(db: DbOrTx, before: Date, limit: number): Promise<PaymentRow[]> {
  return db
    .select()
    .from(payments)
    .where(
      and(
        inArray(payments.status, ['pending', 'created', 'paid']),
        lt(payments.updatedAt, before),
        or(isNull(payments.lastCheckedAt), lt(payments.lastCheckedAt, before)),
      ),
    )
    .orderBy(sql`${payments.lastCheckedAt} asc nulls first`, asc(payments.updatedAt))
    .limit(limit);
}

export async function markPaymentChecked(db: DbOrTx, id: string, at: Date): Promise<void> {
  await db.update(payments).set({ lastCheckedAt: at }).where(eq(payments.id, id));
}

// -------------------------------------------------------- events & deliveries

export async function insertPaymentEvent(
  tx: DbOrTx,
  e: { id: string; merchantId: string; paymentId: string; type: string; payload: Record<string, unknown> },
): Promise<PaymentEventRow | undefined> {
  const [row] = await tx
    .insert(paymentEvents)
    .values(e)
    .onConflictDoNothing({ target: [paymentEvents.paymentId, paymentEvents.type] })
    .returning();
  return row;
}

export function listPaymentEvents(db: DbOrTx, paymentId: string): Promise<PaymentEventRow[]> {
  return db.select().from(paymentEvents).where(eq(paymentEvents.paymentId, paymentId)).orderBy(asc(paymentEvents.createdAt));
}

/** merchantId -> enabled endpoints (id + subscribed events), cached per indexer batch. */
export type EndpointCache = Map<string, { id: string; events: string[] }[]>;

/** Enqueues one delivery per enabled endpoint subscribed to the event type. */
export async function enqueueDeliveries(tx: DbOrTx, event: PaymentEventRow, cache?: EndpointCache): Promise<number> {
  let endpoints = cache?.get(event.merchantId);
  if (!endpoints) {
    endpoints = await tx
      .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.merchantId, event.merchantId), eq(webhookEndpoints.enabled, true)));
    cache?.set(event.merchantId, endpoints);
  }
  const targets = endpoints.filter((e) => e.events.includes(event.type));
  if (targets.length === 0) return 0;
  const rows = await tx
    .insert(webhookDeliveries)
    .values(targets.map((e) => ({ endpointId: e.id, eventId: event.id, merchantId: event.merchantId, status: 'pending' as const })))
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

// ------------------------------------------------------------------ webhooks

export async function insertWebhookEndpoint(
  db: DbOrTx,
  e: { merchantId: string; url: string; secretEnc: string; events: string[] },
): Promise<WebhookEndpointRow> {
  const [row] = await db.insert(webhookEndpoints).values(e).returning();
  if (!row) throw new Error('insert endpoint returned no row');
  return row;
}

export function listWebhookEndpoints(db: DbOrTx, merchantId: string): Promise<WebhookEndpointRow[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, merchantId))
    .orderBy(asc(webhookEndpoints.createdAt));
}

export async function findWebhookEndpoint(db: DbOrTx, merchantId: string, id: string): Promise<WebhookEndpointRow | undefined> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
    .limit(1);
  return row;
}

export async function findWebhookEndpointById(db: DbOrTx, id: string): Promise<WebhookEndpointRow | undefined> {
  const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).limit(1);
  return row;
}

export async function updateWebhookEndpoint(
  db: DbOrTx,
  merchantId: string,
  id: string,
  patch: Partial<Pick<WebhookEndpointRow, 'url' | 'events' | 'enabled'>>,
): Promise<WebhookEndpointRow | undefined> {
  const [row] = await db
    .update(webhookEndpoints)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
    .returning();
  return row;
}

export async function deleteWebhookEndpoint(db: DbOrTx, merchantId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.merchantId, merchantId)))
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}

export function listDeliveries(
  db: DbOrTx,
  q: { merchantId: string; endpointId?: string; status?: string; limit: number },
): Promise<WebhookDeliveryRow[]> {
  const conds: SQL[] = [eq(webhookDeliveries.merchantId, q.merchantId)];
  if (q.endpointId) conds.push(eq(webhookDeliveries.endpointId, q.endpointId));
  if (q.status) conds.push(eq(webhookDeliveries.status, q.status as WebhookDeliveryRow['status']));
  return db
    .select()
    .from(webhookDeliveries)
    .where(and(...conds))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(q.limit);
}

export async function findDelivery(db: DbOrTx, merchantId: string, id: string): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.merchantId, merchantId)))
    .limit(1);
  return row;
}

export async function findPaymentEvent(db: DbOrTx, id: string): Promise<PaymentEventRow | undefined> {
  const [row] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, id)).limit(1);
  return row;
}

export async function updateDelivery(
  db: DbOrTx,
  id: string,
  patch: Partial<typeof webhookDeliveries.$inferInsert>,
): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, id))
    .returning();
  return row;
}

/**
 * Claims up to `limit` due deliveries for this worker: due `pending` rows, or
 * `sending` rows whose lock expired (a crashed worker). Uses
 * `FOR UPDATE SKIP LOCKED` so concurrent workers never claim the same row.
 */
export async function claimDueDeliveries(db: Db, now: Date, lockMs: number, limit: number): Promise<WebhookDeliveryRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        or(
          and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)),
          and(eq(webhookDeliveries.status, 'sending'), lt(webhookDeliveries.lockedUntil, now)),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(webhookDeliveries)
      .set({ status: 'sending', lockedUntil: new Date(now.getTime() + lockMs), updatedAt: now })
      .where(inArray(webhookDeliveries.id, due.map((d) => d.id)))
      .returning();
  });
}

// --------------------------------------------------------------- idempotency

export type IdempotencyRow = typeof idempotencyKeys.$inferSelect;

/** Inserts the in-flight marker; returns the existing row if the key was already used. */
export async function claimIdempotencyKey(
  db: DbOrTx,
  k: { merchantId: string; key: string; method: string; path: string; requestHash: string },
): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRow }> {
  const inserted = await db.insert(idempotencyKeys).values(k).onConflictDoNothing().returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { claimed: true };
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.merchantId, k.merchantId), eq(idempotencyKeys.key, k.key)))
    .limit(1);
  if (!existing) return claimIdempotencyKey(db, k);
  return { claimed: false, existing };
}

export async function completeIdempotencyKey(
  db: DbOrTx,
  merchantId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ responseStatus: status, responseBody: body })
    .where(and(eq(idempotencyKeys.merchantId, merchantId), eq(idempotencyKeys.key, key)));
}

export async function releaseIdempotencyKey(db: DbOrTx, merchantId: string, key: string): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.merchantId, merchantId), eq(idempotencyKeys.key, key), isNull(idempotencyKeys.responseStatus)));
}

// -------------------------------------------------------------- indexer state

export async function getIndexerState(db: DbOrTx, key: string): Promise<{ cursor: string; lastLedger: number | null } | undefined> {
  const [row] = await db.select().from(indexerState).where(eq(indexerState.key, key)).limit(1);
  return row ? { cursor: row.cursor, lastLedger: row.lastLedger } : undefined;
}

export async function setIndexerState(db: DbOrTx, key: string, cursor: string, lastLedger: number): Promise<void> {
  await db
    .insert(indexerState)
    .values({ key, cursor, lastLedger })
    .onConflictDoUpdate({ target: indexerState.key, set: { cursor, lastLedger, updatedAt: new Date() } });
}
