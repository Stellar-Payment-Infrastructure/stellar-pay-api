# Roadmap

## v0.1.0 (current, testnet)

Payments API with secret keys, public checkout endpoints, transaction build/verify/submit, event indexer and
reconciler, signed webhooks with retries and SSRF protection, generated OpenAPI with Swagger UI, and the
`stellar-pay-sdk` TypeScript client. See the [README](README.md#what-is-implemented).

## Open Wave issues

Deliberately left for contributors. Each code task has a `TODO(wave: api-N)` marker at its plug-in point.

| Id | Points | Issue | Starting point |
|---|---|---|---|
| api-1 | 4 | **GraphQL support:** schema and resolvers over the existing services, same auth and scopes, cursor pagination, tests | `src/app.ts` (route mounting), `src/payments/service.ts` |
| api-2 | 3 | **Rate limiting:** per-API-key limits, Redis-backed store, `RateLimit-*` headers, configuration, a documented 429 contract, tests | `src/http/middleware.ts` |
| api-3 | 3 | **API documentation:** descriptions and examples for every route, an error-code catalog, authentication and webhook guides, SDK usage | `src/openapi/spec.ts`, `docs/` |
| api-4 | 2 | **Security guidelines:** key handling, webhook verification, SSRF, secrets management, deployment hardening | [SECURITY.md](SECURITY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) |

## Later

- Multi-token payments once the contract supports a token allowlist (stellar-pay-core core-1).
- Push updates (SSE) for checkout status, key rotation tooling for the operator key, audit logging.

## Not planned for v1

Mainnet, a Python SDK or FastAPI server, fiat on-ramp integrations (the frontend ships an interface only).
