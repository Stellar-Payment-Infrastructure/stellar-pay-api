import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

/** The Stellar public network passphrase. This service refuses to run against it. */
export const PUBNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const contractId = z.string().refine((v) => StrKey.isValidContract(v), 'must be a C... contract id');

const hexKey32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes as 64 hex characters');

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1),
    STELLAR_NETWORK: z.literal('testnet').default('testnet'),
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    NETWORK_PASSPHRASE: z.string().default(TESTNET_PASSPHRASE),
    PAY_CONTRACT_ID: contractId,
    PAY_TOKEN_CONTRACT_ID: contractId,
    /** Display metadata for the single configured token (v1). */
    PAY_TOKEN_CODE: z.string().min(1).max(12).default('XLM'),
    PAY_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(18).default(7),
    /** Operator secret key (testnet only). Never logged. */
    OPERATOR_SECRET: z.string().refine((v) => StrKey.isValidEd25519SecretSeed(v), 'must be an S... secret seed'),
    /** Server-side pepper mixed into API key hashes. */
    API_KEY_PEPPER: z.string().min(32),
    /** AES-256-GCM key that encrypts webhook secrets at rest. */
    WEBHOOK_SECRET_ENC_KEY: hexKey32,
    /** Upper bound on a single payment amount in token base units. */
    MAX_PAYMENT_AMOUNT: z
      .string()
      .regex(/^[1-9]\d*$/)
      .default('9223372036854775807'),
    /** Max fee (stroops) accepted on a payer-signed pay transaction. */
    MAX_PAY_TX_FEE: z.coerce.number().int().positive().default(10_000_000),
    INDEXER_POLL_MS: z.coerce.number().int().min(250).default(5000),
    /** Ledger to start indexing from when no cursor is stored (0 = latest - 1000). */
    INDEXER_START_LEDGER: z.coerce.number().int().min(0).default(0),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
    RECONCILE_AFTER_MS: z.coerce.number().int().min(0).default(120_000),
    WEBHOOK_POLL_MS: z.coerce.number().int().min(100).default(2000),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
    /** Allow http:// and loopback webhook URLs. Development/test only. */
    WEBHOOK_ALLOW_INSECURE: boolish.default('false'),
    PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    /** Comma-separated origins allowed to call the public checkout routes. */
    CORS_ORIGINS: z.string().default(''),
    /** Hosted checkout base URL used to build `checkoutUrl`. */
    CHECKOUT_BASE_URL: z.string().url().default('http://localhost:3001'),
    WORKERS_ENABLED: boolish.default('true'),
    MIGRATE_ON_START: boolish.default('true'),
  })
  .superRefine((c, ctx) => {
    if (c.NETWORK_PASSPHRASE === PUBNET_PASSPHRASE) {
      ctx.addIssue({ code: 'custom', path: ['NETWORK_PASSPHRASE'], message: 'mainnet is not supported (testnet only)' });
    }
    if (c.NODE_ENV === 'production' && c.WEBHOOK_ALLOW_INSECURE) {
      ctx.addIssue({ code: 'custom', path: ['WEBHOOK_ALLOW_INSECURE'], message: 'must be false in production' });
    }
  });

export type Config = z.infer<typeof configSchema> & { corsOrigins: string[]; maxPaymentAmount: bigint };

export class ConfigError extends Error {
  constructor(public readonly issues: Record<string, string[]>) {
    super(`Invalid configuration: ${Object.keys(issues).join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses and validates configuration. Error messages never echo values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? 'config');
      (issues[key] ??= []).push(issue.message);
    }
    throw new ConfigError(issues);
  }
  const c = result.data;
  return {
    ...c,
    corsOrigins: c.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    maxPaymentAmount: BigInt(c.MAX_PAYMENT_AMOUNT),
  };
}
