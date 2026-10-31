import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeOpenApi } from '../src/openapi/spec.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi', 'openapi.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, serializeOpenApi());
console.log(`wrote ${path.relative(process.cwd(), out)}`);
