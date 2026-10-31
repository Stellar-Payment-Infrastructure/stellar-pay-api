import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb, migrateDb } from './db/client.js';
import { createLogger } from './logger.js';
import { RpcChainClient } from './stellar/chain.js';
import { createSender } from './webhooks/http.js';
import { startWorkers } from './workers.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Only variable names and messages, never values.
      console.error('Invalid configuration:', JSON.stringify(err.issues));
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.NODE_ENV === 'development' });
  if (config.MIGRATE_ON_START) await migrateDb(config.DATABASE_URL);
  const { db, close } = await createDb(config.DATABASE_URL);
  const chain = RpcChainClient.fromUrl(config.SOROBAN_RPC_URL, {
    contractId: config.PAY_CONTRACT_ID,
    networkPassphrase: config.NETWORK_PASSPHRASE,
    operatorSecret: config.OPERATOR_SECRET,
  });
  const send = createSender({ policy: { allowInsecure: config.WEBHOOK_ALLOW_INSECURE }, timeoutMs: config.WEBHOOK_TIMEOUT_MS });
  const app = createApp({ config, db, chain, logger });
  const workers = config.WORKERS_ENABLED ? startWorkers({ config, db, chain, logger, send }) : null;

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, network: config.STELLAR_NETWORK, contractId: config.PAY_CONTRACT_ID, operator: chain.operatorAddress }, 'stellar-pay-api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    workers?.stop();
    server.close(() => {
      void close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
