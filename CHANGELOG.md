# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - not yet tagged

First release, testnet only.

### Added

- Merchants and scoped secret API keys (peppered HMAC-SHA256 hashes, constant-time comparison).
- Payments: create (on-chain, idempotent with `Idempotency-Key`), get, list with cursor pagination, settle,
  cancel, refund.
- Public checkout: payment view, unsigned `pay` transaction builder with an on-chain record check, and a submit
  route that accepts only a single `pay` call for that payment.
- Soroban event indexer with a persisted cursor, and a reconciler that repairs missed events from on-chain state.
- Signed webhooks: encrypted secrets, timestamped HMAC signatures, retries with backoff, SSRF protection.
- OpenAPI 3 document generated from the request schemas, Swagger UI at `/docs`, and a drift check.
- Docker image and compose file.

### Security

- `drizzle-orm` 0.45.4 (SQL injection advisory in 0.35.x); overrides pin `follow-redirects` and `qs`.
- The Docker image runs as the unprivileged `node` user.
