# Threat model (one page)

Scope: stellar-pay-api v0.1.0 on testnet. The full security guide is Wave issue api-4; this page lists what the code
does today. The contract's own threat model is in stellar-pay-core `docs/SPEC.md` §11.

## What we protect

| Asset | Where it lives |
|---|---|
| Operator secret key (authorizes create/settle/cancel/refund) | `OPERATOR_SECRET` env var, never logged |
| Merchant API keys | Shown once; stored as HMAC-SHA256(pepper, key) |
| Webhook signing secrets | AES-256-GCM encrypted at rest with `WEBHOOK_SECRET_ENC_KEY` |
| Payment state integrity | Postgres, derived from contract events and checked against on-chain state |
| Merchant order data (`reference`, `metadata`) | Postgres only; on-chain gets `sha256(payment id ‖ reference)` |

## Threats and mitigations

| Threat | Mitigation in code |
|---|---|
| Stolen or leaked API key | Scoped keys, revocation, constant-time comparison; a database leak does not reveal keys (peppered hashes) |
| Operator key compromise | The contract only pays the merchant, the fee recipient or the payer, so the key can stall, cancel or refund but cannot redirect funds |
| Using the submit route as a relay | `verifyPayTx` accepts only one `pay` call to the configured contract for that payment id, on the testnet passphrase, under `MAX_PAY_TX_FEE` |
| Payment-id squatting (core finding M1) | Ids are 32 random bytes; the API builds a pay transaction only if the on-chain merchant, amount and operator match its record; the reconciler never adopts an on-chain record created under our id by someone else |
| Webhook SSRF | URL resolved and checked against private, loopback, link-local (incl. cloud metadata), and reserved ranges at registration and again at send time; redirects are not followed; plain HTTP and loopback only with `WEBHOOK_ALLOW_INSECURE` (rejected in production) |
| Forged webhooks to merchants | HMAC-SHA256 over `timestamp.rawBody`, timestamp tolerance in the SDK verifier, stable event ids for deduplication |
| Duplicate or replayed chain events | Unique `(tx_hash, event_index)`, idempotent application in one database transaction, one-way status transitions |
| RPC outage or event-retention gap | Persisted cursor; reconciler repairs from `get_payment`; outages return 503 without changing state |
| Injection | Every input validated with Zod; Drizzle parameterized queries only |
| Abuse of public endpoints | 64 KB body limit, pagination caps, naive per-process rate limit on public routes |
| Cross-origin misuse | CORS enabled only on public checkout routes, only for `CORS_ORIGINS` |
| Leaking internals | Stable error envelope without stack traces; pino redaction; a test greps all logs for secret material |

## Known gaps (accepted for v0.1.0)

- Rate limiting is in-memory and per process, public routes only (Wave api-2).
- One operator key for all merchants; no key rotation tooling.
- No WAF, no audit logging of admin actions, no professional penetration test.
- Testnet only: the configuration refuses the public network passphrase.
