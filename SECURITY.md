# Security policy

## Status

stellar-pay-api is **testnet-only** (it refuses the public network passphrase) and has not had a professional
security review. The one-page threat model is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

| Version | Supported |
|---|---|
| 0.1.x | Yes (testnet) |

## Reporting a vulnerability

Please report privately through GitHub:
[Report a vulnerability](https://github.com/Stellar-Payment-Infrastructure/stellar-pay-api/security/advisories/new).
Do not open a public issue. Include the route or component, steps to reproduce, and the impact. We aim to
acknowledge reports within 3 business days.

## Operating the API safely

- Keep `OPERATOR_SECRET`, `API_KEY_PEPPER` and `WEBHOOK_SECRET_ENC_KEY` in a secret manager or a gitignored `.env`.
  Generate them fresh per deployment; never reuse the example values.
- Use secret API keys only server-side. Browsers use the public checkout endpoints, which need no key.
- Set `CORS_ORIGINS` to your checkout origins only, and keep `WEBHOOK_ALLOW_INSECURE=false` outside local development.
- Webhook consumers must verify the signature against the raw body, check the timestamp, and deduplicate by event id
  (see the SDK README).
- Run `pnpm audit` before releases; Dependabot is configured for npm, Docker and GitHub Actions.

<!-- TODO(wave: api-4): expand into a full security guide (key handling, webhook verification, SSRF, secrets
     management, deployment hardening), linked from the README. -->

