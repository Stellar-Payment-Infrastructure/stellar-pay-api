# stellar-pay-api

[![CI](https://github.com/Stellar-Payment-Infrastructure/stellar-pay-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Stellar-Payment-Infrastructure/stellar-pay-api/actions/workflows/ci.yml)

**Status: testnet only · v0.1.0.** The API refuses to start with the public network passphrase.

An Express API that hides Soroban and XDR from merchant backends. Merchants create payments with a secret API key;
payers pay from their own wallet through public checkout endpoints; an indexer follows the
[stellar-pay-core](https://github.com/Stellar-Payment-Infrastructure/stellar-pay-core) contract's events and
delivers signed webhooks. This repository also contains the TypeScript SDK, [`stellar-pay-sdk`](sdk/README.md).

## What is implemented

- **Merchants and API keys:** secret keys (`sk_test_…`) with scopes (`payments:read`, `payments:write`,
  `webhooks:read`, `webhooks:write`), stored as peppered HMAC-SHA256 hashes and compared in constant time.
- **Payments:** create (on-chain `create_payment`, random 32-byte id, idempotent with `Idempotency-Key`), get,
  list with cursor pagination, settle, cancel, refund. Amounts are integer base units sent as decimal strings.
- **Public checkout:** read a payment, build an unsigned `pay` transaction for the payer's wallet, submit the signed
  transaction. Before building, the API checks that the on-chain payment matches its record (merchant, amount,
  operator). On submit it accepts only a single `pay` call to the configured contract for that payment id, on the
  testnet passphrase, under a fee cap. It never relays arbitrary transactions.
- **Indexer and reconciler:** polls Soroban RPC `getEvents` with a persisted cursor, applies events atomically and
  idempotently, never moves a payment backwards, and repairs missed events from on-chain state.
- **Webhooks:** endpoints with secrets encrypted at rest (AES-256-GCM), HMAC-SHA256 signatures with a timestamp
  (`Stellar-Pay-Signature: t=…,v1=…`), at-least-once delivery with backoff (8 attempts over about 22 hours), SSRF
  protection checked at registration and again at send time, no redirects followed, manual retry.
  Events: `payment.created`, `payment.paid`, `payment.settled`, `payment.refunded`, `payment.cancelled`.
- **OpenAPI 3** generated from the same Zod schemas that validate requests, served at `/v1/openapi.json`, with
  Swagger UI at `/docs`. CI fails if the committed spec or the SDK's copy drifts.
- **Hardening:** helmet headers, 64 KB JSON body limit, CORS only on public routes and only for `CORS_ORIGINS`,
  a naive in-memory rate limit on public routes, log redaction (a test greps the logs for secret material),
  stable error envelope `{ "error": { "code", "message", "details" } }`.

## Not implemented yet

- **One token** (the contract's configured token); multi-token follows core-1.
- **Rate limiting** is per-process and in-memory, public routes only ([api-2](ROADMAP.md)).
- **No GraphQL** ([api-1](ROADMAP.md)); REST only.
- **Docs** are the generated OpenAPI reference only; guides are [api-3](ROADMAP.md), the full security guide
  [api-4](ROADMAP.md).
- **Not deployed** to a public URL yet.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/payments` | secret key, `payments:write` | Create a payment (send `Idempotency-Key`) |
| `GET /v1/payments`, `GET /v1/payments/{id}` | `payments:read` | List (cursor pagination) and get |
| `POST /v1/payments/{id}/settle` · `/cancel` · `/refund` | `payments:write` | Operator actions |
| `GET /v1/public/payments/{id}` | none (unguessable id) | Checkout view of a payment |
| `POST /v1/public/payments/{id}/transaction` | none | Build the unsigned `pay` transaction for a payer |
| `POST /v1/public/payments/{id}/submit` | none | Submit the payer-signed transaction |
| `/v1/webhook-endpoints`, `/v1/webhook-deliveries` | `webhooks:*` | Manage endpoints, inspect and retry deliveries |
| `GET /v1/merchant`, `/v1/api-keys` | secret key | Merchant profile and key management |
| `GET /v1/health`, `GET /v1/openapi.json`, `GET /docs` | none | Health, spec, Swagger UI |

## Run locally

Requirements: Node 22+, pnpm 9, and Postgres 16 (or Docker). The API reads configuration from environment variables
only ([src/config.ts](src/config.ts)); it does not load `.env` by itself.

```bash
pnpm install
cp .env.example .env              # fill in OPERATOR_SECRET, API_KEY_PEPPER, WEBHOOK_SECRET_ENC_KEY
docker compose up -d postgres     # or point DATABASE_URL at your own Postgres
pnpm exec tsx --env-file=.env scripts/seed.ts --name acme --display "Acme Store" --payout G...   # prints an API key once
pnpm exec tsx watch --env-file=.env src/server.ts
```

Migrations run on start (`MIGRATE_ON_START=true`). The whole stack in Docker: `docker compose up --build`.

Then, with the SDK on your server:

```ts
import { StellarPay } from 'stellar-pay-sdk';

const sp = new StellarPay({ apiKey: process.env.STELLAR_PAY_API_KEY!, baseUrl: 'http://localhost:3000' });
const payment = await sp.payments.create({ amount: 10_000_000n, reference: 'order-42' }); // 1 XLM
console.log(payment.checkoutUrl);
```

## Verify

```bash
pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run openapi:check
```

Tests run against an embedded Postgres (pglite), so no database is needed. They include HTTP tests, adversarial
submit tests, indexer replay/ordering/crash tests, webhook tests against a local receiver, negative end-to-end flows
(wallet cancel, insufficient balance, wrong network, already paid, RPC down, webhook endpoint down), and scale
checks (10k indexed events, 5k paginated payments). The scale checks are slow on small machines.

`INTEGRATION=1 PAY_CONTRACT_ID=C... pnpm exec vitest run test/integration.testnet.test.ts` runs a read-only check
against the live testnet contract (CI runs it weekly). `pnpm e2e:testnet` drives the full flow against a running
API on testnet (create → payer signs → indexer → signed webhook → settle); it needs a merchant key from the seed
script and a funded testnet payer (see the header of [scripts/e2e-testnet.ts](scripts/e2e-testnet.ts)).

## Contract and bindings

The API targets the testnet contract in [`.env.example`](.env.example) (from stellar-pay-core
`deployments/testnet.json`). TypeScript bindings generated with `stellar contract bindings typescript` are committed
in [src/generated/bindings](src/generated/bindings) for reference; the API encodes calls with `@stellar/stellar-sdk`
directly in [src/stellar/contract.ts](src/stellar/contract.ts) and checks them against the contract's event test
vectors. When the contract changes, refresh both artifacts from stellar-pay-core:

```bash
cp ../stellar-pay-core/docs/test-vectors.json src/generated/contract-test-vectors.json
stellar contract bindings typescript --network testnet --contract-id <C...> --output-dir src/generated/bindings --overwrite
```

**Testnet resets** delete contracts and accounts: redeploy the contract, update `PAY_CONTRACT_ID`, and reset the
indexer cursor.

After changing a route or schema, run `pnpm sdk:sync` to regenerate `openapi/openapi.json`, copy it into the SDK and
regenerate the SDK types.

## Security

See [SECURITY.md](SECURITY.md) and the one-page [threat model](docs/THREAT_MODEL.md).

## Compatibility

| stellar-pay-api | stellar-pay-core contract | stellar-pay-sdk | API |
|---|---|---|---|
| 0.1.x | 0.1.x (`CDB5PL5R…IS4I` on testnet) | 0.1.x | `/v1` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the open Wave issues in [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
