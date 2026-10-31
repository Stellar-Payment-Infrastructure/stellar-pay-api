import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

/** Any Drizzle Postgres database (postgres-js in production, PGlite in tests/dev). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * `pglite://` URLs run the API on an embedded Postgres (development/demo only;
 * PGlite is a devDependency). `pglite://memory` is ephemeral, any other value
 * is used as the on-disk data directory. Production uses a real `postgres://`.
 */
const PGLITE_PREFIX = 'pglite://';

export function isPgliteUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith(PGLITE_PREFIX);
}

function pgliteDataDir(databaseUrl: string): string | undefined {
  const rest = databaseUrl.slice(PGLITE_PREFIX.length).replace(/^\/+/, '');
  return rest === '' || rest === 'memory' || rest === ':memory:' ? undefined : rest;
}

export async function createDb(databaseUrl: string): Promise<{ db: Db; close: () => Promise<void> }> {
  if (isPgliteUrl(databaseUrl)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: pgliteDrizzle } = await import('drizzle-orm/pglite');
    const client = new PGlite(pgliteDataDir(databaseUrl));
    const db = pgliteDrizzle(client, { schema });
    return { db: db as unknown as Db, close: () => client.close() };
  }
  const client = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export async function migrateDb(databaseUrl: string): Promise<void> {
  if (isPgliteUrl(databaseUrl)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: pgliteDrizzle } = await import('drizzle-orm/pglite');
    const { migrate: pgliteMigrate } = await import('drizzle-orm/pglite/migrator');
    const client = new PGlite(pgliteDataDir(databaseUrl));
    try {
      await pgliteMigrate(pgliteDrizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.close();
    }
    return;
  }
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export { schema };
