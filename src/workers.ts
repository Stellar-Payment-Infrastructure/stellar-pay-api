import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { runIndexerBatch, runReconciler } from './indexer/indexer.js';
import type { Logger } from './logger.js';
import type { ChainClient } from './stellar/chain.js';
import { runDispatcherBatch } from './webhooks/dispatcher.js';
import type { Sender } from './webhooks/http.js';

export interface WorkerHealth {
  indexer: { lastSuccessAt: string | null; consecutiveFailures: number };
}

/**
 * Background loops: indexer (with exponential backoff on RPC errors),
 * reconciler and webhook dispatcher. Each loop runs one batch at a time.
 */
export function startWorkers(deps: { config: Config; db: Db; chain: ChainClient; logger: Logger; send: Sender }) {
  const { config, logger } = deps;
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const health: WorkerHealth = { indexer: { lastSuccessAt: null, consecutiveFailures: 0 } };

  const loop = (name: string, intervalMs: number, fn: () => Promise<unknown>, backoff = false) => {
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
        failures = 0;
        if (name === 'indexer') {
          health.indexer = { lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 };
        }
      } catch (err) {
        failures++;
        if (name === 'indexer') health.indexer.consecutiveFailures = failures;
        logger.warn({ worker: name, failures, err: (err as Error).message }, 'worker iteration failed');
      }
      if (stopped) return;
      const delay = backoff && failures > 0 ? Math.min(intervalMs * 2 ** failures, 5 * 60_000) : intervalMs;
      const t = setTimeout(() => {
        timers.delete(t);
        void tick();
      }, delay);
      timers.add(t);
    };
    void tick();
  };

  loop('indexer', config.INDEXER_POLL_MS, () => runIndexerBatch(deps), true);
  loop('reconciler', config.RECONCILE_INTERVAL_MS, () => runReconciler(deps));
  loop('webhooks', config.WEBHOOK_POLL_MS, () => runDispatcherBatch(deps));

  return {
    health,
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
