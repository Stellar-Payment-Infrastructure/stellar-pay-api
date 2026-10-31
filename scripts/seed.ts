/**
 * Creates a merchant and its first API key, and prints the key ONCE.
 *
 *   pnpm seed --name acme --display "Acme Store" --payout G...
 *
 * Only DATABASE_URL and API_KEY_PEPPER are needed.
 */
import { parseArgs } from 'node:util';
import { StrKey } from '@stellar/stellar-sdk';
import { generateApiKey, SCOPES } from '../src/auth/apiKeys.js';
import { createDb, migrateDb } from '../src/db/client.js';
import { insertApiKey, insertMerchant } from '../src/db/repo.js';

async function main() {
  const { values } = parseArgs({
    options: { name: { type: 'string' }, display: { type: 'string' }, payout: { type: 'string' } },
  });
  const databaseUrl = process.env['DATABASE_URL'];
  const pepper = process.env['API_KEY_PEPPER'];
  if (!databaseUrl || !pepper || pepper.length < 32) throw new Error('DATABASE_URL and API_KEY_PEPPER (32+ chars) are required');
  if (!values.name || !values.payout) throw new Error('usage: pnpm seed --name <slug> --display <name> --payout <G...|C...>');
  if (!StrKey.isValidEd25519PublicKey(values.payout) && !StrKey.isValidContract(values.payout)) {
    throw new Error('--payout must be a valid Stellar address');
  }
  await migrateDb(databaseUrl);
  const { db, close } = await createDb(databaseUrl);
  try {
    const merchant = await insertMerchant(db, { name: values.name, displayName: values.display ?? values.name, payoutAddress: values.payout });
    const { key, prefix, hash } = generateApiKey(pepper);
    await insertApiKey(db, { merchantId: merchant.id, prefix, hash, scopes: [...SCOPES] });
    console.log(`merchant ${merchant.id} (${merchant.name}) created`);
    console.log('API key (shown once, store it in your secret manager):');
    console.log(key);
  } finally {
    await close();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
