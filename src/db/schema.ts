import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  /** Stellar address (G... or C...) that receives settled funds. */
  payoutAddress: varchar('payout_address', { length: 56 }).notNull(),
  createdAt: ts('created_at').defaultNow().notNull(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    /** Visible, non-secret lookup prefix (e.g. `sk_test_ab12cd34`). */
    prefix: varchar('prefix', { length: 32 }).notNull(),
    /** HMAC-SHA256(pepper, key), hex. The plain key is never stored. */
    hash: varchar('hash', { length: 64 }).notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: ts('created_at').defaultNow().notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => ({
    prefixIdx: index('api_keys_prefix_idx').on(t.prefix),
    hashIdx: uniqueIndex('api_keys_hash_idx').on(t.hash),
  }),
);

/**
 * API-level payment status. `pending` = row written, on-chain create not yet
 * confirmed; `failed` = on-chain create never landed (repaired by the
 * reconciler). The others mirror the contract states.
 */
export const PAYMENT_STATUSES = ['pending', 'created', 'paid', 'settled', 'refunded', 'cancelled', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = pgTable(
  'payments',
  {
    /** 32-byte payment id, lowercase hex (also the on-chain id). */
    id: varchar('id', { length: 64 }).primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 16 }).$type<PaymentStatus>().notNull(),
    /** Base units; numeric(39,0) covers the full i128 range. */
    amount: numeric('amount', { precision: 39, scale: 0 }).notNull(),
    token: varchar('token', { length: 56 }).notNull(),
    merchantAddress: varchar('merchant_address', { length: 56 }).notNull(),
    settleMode: varchar('settle_mode', { length: 8 }).$type<'auto' | 'manual'>().notNull(),
    payer: varchar('payer', { length: 56 }),
    /** Merchant-supplied reference (off-chain only). */
    reference: varchar('reference', { length: 128 }),
    /** sha256(payment id || reference): the only reference data on-chain. */
    referenceHash: varchar('reference_hash', { length: 64 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    feeBps: integer('fee_bps'),
    fee: numeric('fee', { precision: 39, scale: 0 }),
    createTxHash: varchar('create_tx_hash', { length: 64 }),
    payTxHash: varchar('pay_tx_hash', { length: 64 }),
    settleTxHash: varchar('settle_tx_hash', { length: 64 }),
    refundTxHash: varchar('refund_tx_hash', { length: 64 }),
    cancelTxHash: varchar('cancel_tx_hash', { length: 64 }),
    /** Last time the reconciler compared this row with the chain. */
    lastCheckedAt: ts('last_checked_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    merchantCreatedIdx: index('payments_merchant_created_idx').on(t.merchantId, t.createdAt, t.id),
    merchantUpdatedIdx: index('payments_merchant_updated_idx').on(t.merchantId, t.updatedAt, t.id),
    statusUpdatedIdx: index('payments_status_updated_idx').on(t.status, t.updatedAt),
  }),
);

/** Raw contract events, deduplicated by (tx hash, event index). */
export const chainEvents = pgTable(
  'chain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rpcEventId: varchar('rpc_event_id', { length: 64 }).notNull(),
    ledger: bigint('ledger', { mode: 'number' }).notNull(),
    txHash: varchar('tx_hash', { length: 64 }).notNull(),
    eventIndex: integer('event_index').notNull(),
    contractId: varchar('contract_id', { length: 56 }).notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    paymentId: varchar('payment_id', { length: 64 }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => ({
    txEventIdx: uniqueIndex('chain_events_tx_event_idx').on(t.txHash, t.eventIndex),
    paymentIdx: index('chain_events_payment_idx').on(t.paymentId),
  }),
);

export const indexerState = pgTable('indexer_state', {
  key: varchar('key', { length: 64 }).primaryKey(),
  cursor: text('cursor').notNull(),
  lastLedger: bigint('last_ledger', { mode: 'number' }),
  updatedAt: ts('updated_at').defaultNow().notNull(),
});

/** API-level payment events: the unit of webhook delivery. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    /** `evt_` + 24 hex chars. */
    id: varchar('id', { length: 32 }).primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    paymentId: varchar('payment_id', { length: 64 })
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => ({
    paymentTypeIdx: uniqueIndex('payment_events_payment_type_idx').on(t.paymentId, t.type),
  }),
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** AES-256-GCM ciphertext of the signing secret (iv.tag.ciphertext, base64url). */
    secretEnc: text('secret_enc').notNull(),
    events: text('events').array().notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    merchantIdx: index('webhook_endpoints_merchant_idx').on(t.merchantId),
  }),
);

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'sending', 'succeeded', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 32 })
      .notNull()
      .references(() => paymentEvents.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id').notNull(),
    status: varchar('status', { length: 16 }).$type<WebhookDeliveryStatus>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').defaultNow().notNull(),
    lockedUntil: ts('locked_until'),
    responseCode: integer('response_code'),
    responseMs: integer('response_ms'),
    error: text('error'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    endpointEventIdx: uniqueIndex('webhook_deliveries_endpoint_event_idx').on(t.endpointId, t.eventId),
    dueIdx: index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    merchantIdx: index('webhook_deliveries_merchant_idx').on(t.merchantId, t.createdAt),
  }),
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    method: varchar('method', { length: 8 }).notNull(),
    path: text('path').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    /** null while the first request is still in flight. */
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.merchantId, t.key] }),
  }),
);
