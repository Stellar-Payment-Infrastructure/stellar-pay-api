import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeOpenApi } from '../src/openapi/spec.js';

const committedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi', 'openapi.json');
const sdkCopyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sdk', 'openapi.json');
const generated = serializeOpenApi();
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '');

let ok = true;
if (read(committedPath) !== generated) {
  console.error('openapi/openapi.json is stale. Run `pnpm openapi:generate`.');
  ok = false;
}
if (existsSync(path.dirname(sdkCopyPath)) && read(sdkCopyPath) !== generated) {
  console.error('sdk/openapi.json is stale. Run `bash ../scripts/sync-sdk.sh` from the repo root (or `pnpm --dir sdk generate`).');
  ok = false;
}
if (!ok) process.exit(1);
console.log('OpenAPI spec is up to date (api and sdk).');
