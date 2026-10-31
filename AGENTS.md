# AGENTS.md — stellar-pay-api

## Package: stellar-pay-api

Express REST API for Stellar payments with auth, indexer, webhooks, and generated SDK.

### Verify Command

```bash
pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run openapi:check
```

### Key Directories

- `src/config.ts` — Zod-validated environment config
- `src/logger.ts` — Pino logger with secret redaction
- `src/errors/` — typed error classes with stable codes
- `src/db/schema.ts` — Drizzle ORM schema
- `src/repositories/` — data access layer
- `src/middleware/` — auth, idempotency, rate-limit, error handling
- `src/routes/` — REST endpoints
- `src/services/soroban.ts` — Soroban client (simulate, submit, wait)
- `src/services/indexer.ts` — event indexing
- `src/services/webhookDispatcher.ts` — webhook delivery with retry
- `src/openapi/` — OpenAPI generation from Zod schemas
- `src/generated/bindings.ts` — contract bindings (generated)

### Routes

**Authenticated (secret API key):**
- `POST /v1/payments` — create payment
- `GET /v1/payments/:id` — get payment
- `GET /v1/payments` — list with filters/pagination
- `POST /v1/payments/:id/cancel|settle|refund` — operator actions
- `POST/GET/DELETE /v1/webhook-endpoints` — webhook management
- `GET /v1/webhook-deliveries` — delivery log
- `POST /v1/webhook-deliveries/:id/retry` — manual retry

**Public (payment ID only):**
- `GET /v1/public/payments/:id` — minimal checkout view
- `POST /v1/public/payments/:id/transaction` — build unsigned pay tx
- `POST /v1/public/payments/:id/submit` — verify + submit signed tx

### Key Rules

- Amounts: decimal strings in JSON, `bigint` internally
- Idempotency-Key on creating POSTs
- Request IDs in logs
- Secrets never logged (Pino redaction)
- Webhook signatures: HMAC-SHA256(timestamp + "." + body)
- SSRF protection: HTTPS only, block private IPs
- Indexer: atomic DB transaction per batch, monotonic state machine
- Soroban submit: decode envelope, verify exactly one `pay` invoke for this contract+payment

### Database

PostgreSQL + Drizzle ORM. Tables: merchants, api_keys, payments, chain_events, indexer_state, webhook_endpoints, webhook_deliveries, idempotency_keys.

### Generated Artifacts

- `src/generated/bindings.ts` — from `stellar contract bindings typescript`
- SDK in `sdk/` — from OpenAPI spec via `openapi-typescript`
- Run `scripts/sync-bindings.sh` and `scripts/sync-sdk.sh` after contract/API changes