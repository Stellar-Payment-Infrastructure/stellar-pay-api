# Contributing to stellar-pay-api

Thanks for helping. This service builds and verifies payment transactions, so changes get careful review.

## Setup

Node 22+ and pnpm 9. Tests use an embedded Postgres (pglite), so no database is needed to run them.

```bash
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run openapi:check
cd sdk && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
```

The full suite includes slow scale checks (10k indexed events, 5k paginated payments). While iterating, run one
file: `pnpm exec vitest run test/api.test.ts`.

## Wave issues

Planned contributor issues are listed in [ROADMAP.md](ROADMAP.md) and labeled `wave` on GitHub. Ask to be assigned
on the issue before starting, keep to its scope, and resolve its `TODO(wave: api-N)` marker.

## Code rules

- TypeScript `strict`, no `any`. Validate every external input with Zod; route schemas are the single source for
  validation and OpenAPI.
- Money is `bigint` internally and a decimal string in JSON. Never `number`.
- Errors use the envelope `{ error: { code, message, details? } }` with stable string codes.
- Never log secrets or full signed XDR; use the logger, not `console.log`, in library code.
- Creating POSTs honor `Idempotency-Key`.
- After changing a route or schema, run `pnpm sdk:sync` so the committed spec and the SDK stay in sync
  (`openapi:check` fails otherwise).
- Every route needs a happy-path test and at least one failure-path test.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat: add per-key rate limits`,
`fix(sdk): retry on 503`), and add a line to the relevant `CHANGELOG.md` under `[Unreleased]`.

Never commit `.env` files, keys or webhook secrets. Testnet only.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
