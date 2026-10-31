import type { PaymentStatus } from '../db/schema.js';

export const TERMINAL_STATUSES: readonly PaymentStatus[] = ['settled', 'refunded', 'cancelled'];

export const WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'payment.paid',
  'payment.settled',
  'payment.refunded',
  'payment.cancelled',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** On-chain statuses the indexer and reconciler can observe. */
export type ChainStatus = 'created' | 'paid' | 'settled' | 'refunded' | 'cancelled';

/**
 * Monotonic transitions. The chain is the source of truth, so a `pending` or
 * `failed` row may jump to any on-chain state; otherwise only contract edges
 * are allowed and nothing ever moves backwards or out of a terminal state.
 */
const EDGES: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['created', 'paid', 'settled', 'refunded', 'cancelled', 'failed'],
  failed: ['created', 'paid', 'settled', 'refunded', 'cancelled'],
  created: ['paid', 'settled', 'cancelled'],
  paid: ['settled', 'refunded'],
  settled: [],
  refunded: [],
  cancelled: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return EDGES[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Webhook events implied by a transition, in order. Skipped intermediate
 * states still produce their events (e.g. created -> settled in auto mode
 * emits payment.paid then payment.settled) so consumers see a complete history.
 */
export function eventsForTransition(from: PaymentStatus, to: ChainStatus): WebhookEventType[] {
  if (!canTransition(from, to)) return [];
  const out: WebhookEventType[] = [];
  const fromUnconfirmed = from === 'pending' || from === 'failed';
  if (fromUnconfirmed) out.push('payment.created');
  if (to === 'paid' || to === 'settled' || to === 'refunded') {
    if (fromUnconfirmed || from === 'created') out.push('payment.paid');
  }
  if (to !== 'created' && to !== 'paid') out.push(`payment.${to}`);
  return out;
}
