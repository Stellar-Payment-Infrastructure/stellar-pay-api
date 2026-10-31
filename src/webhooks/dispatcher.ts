import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import * as repo from '../db/repo.js';
import type { Logger } from '../logger.js';
import { decryptSecret, SIGNATURE_HEADER, signatureHeader } from './crypto.js';
import type { Sender } from './http.js';

/** Delay before attempt n+1 after attempt n fails (seconds). 8 attempts over ~22h. */
export const RETRY_DELAYS_SEC = [30, 120, 600, 3_600, 10_800, 21_600, 43_200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SEC.length + 1;

/** Backoff with ±20% jitter. `attempt` is the number of attempts made so far. */
export function nextAttemptDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_SEC[Math.min(attempt, RETRY_DELAYS_SEC.length) - 1] ?? RETRY_DELAYS_SEC[0];
  return Math.round(base * 1000 * (0.8 + 0.4 * random()));
}

export interface DispatcherDeps {
  config: Config;
  db: Db;
  logger: Logger;
  send: Sender;
  now?: () => Date;
  random?: () => number;
}

/** Claims due deliveries and sends them. Returns how many were attempted. */
export async function runDispatcherBatch(deps: DispatcherDeps, limit = 20): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const lockMs = deps.config.WEBHOOK_TIMEOUT_MS * 2 + 5_000;
  const claimed = await repo.claimDueDeliveries(deps.db, now, lockMs, limit);
  for (const d of claimed) {
    await deliverOne(deps, d);
  }
  return claimed.length;
}

async function deliverOne(deps: DispatcherDeps, d: repo.WebhookDeliveryRow): Promise<void> {
  const attempt = d.attempt + 1;
  const endpoint = await repo.findWebhookEndpointById(deps.db, d.endpointId);
  const event = await repo.findPaymentEvent(deps.db, d.eventId);
  if (!endpoint || !endpoint.enabled || !event) {
    await repo.updateDelivery(deps.db, d.id, { status: 'failed', attempt, lockedUntil: null, error: 'endpoint disabled or deleted' });
    return;
  }
  const body = JSON.stringify(event.payload);
  const t = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  let secret: string;
  try {
    secret = decryptSecret(endpoint.secretEnc, deps.config.WEBHOOK_SECRET_ENC_KEY);
  } catch {
    await repo.updateDelivery(deps.db, d.id, { status: 'failed', attempt, lockedUntil: null, error: 'secret could not be decrypted' });
    deps.logger.error({ deliveryId: d.id, endpointId: endpoint.id }, 'webhook secret decryption failed');
    return;
  }
  const result = await deps.send(endpoint.url, body, {
    'content-type': 'application/json',
    'user-agent': 'stellar-pay-webhooks/0.1',
    [SIGNATURE_HEADER.toLowerCase()]: signatureHeader(secret, t, body),
    'stellar-pay-event-id': event.id,
    'stellar-pay-delivery-attempt': String(attempt),
  });

  if (result.ok) {
    await repo.updateDelivery(deps.db, d.id, {
      status: 'succeeded',
      attempt,
      lockedUntil: null,
      responseCode: result.status ?? null,
      responseMs: result.ms,
      error: null,
    });
    return;
  }
  const error = result.error ?? `HTTP ${result.status ?? 0}`;
  const exhausted = attempt >= MAX_ATTEMPTS;
  const now = deps.now?.() ?? new Date();
  await repo.updateDelivery(deps.db, d.id, {
    status: exhausted ? 'failed' : 'pending',
    attempt,
    lockedUntil: null,
    responseCode: result.status ?? null,
    responseMs: result.ms,
    error,
    nextAttemptAt: exhausted ? now : new Date(now.getTime() + nextAttemptDelayMs(attempt, deps.random)),
  });
  deps.logger.warn({ deliveryId: d.id, attempt, error, exhausted }, 'webhook delivery failed');
}
