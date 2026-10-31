import { loadConfig } from '../src/config.js';
import { migrateDb } from '../src/db/client.js';

migrateDb(loadConfig().DATABASE_URL)
  .then(() => console.log('migrations applied'))
  .catch((err: Error) => {
    console.error('migration failed:', err.message);
    process.exit(1);
  });
