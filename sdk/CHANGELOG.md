# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - not yet tagged

First release.

### Added

- `StellarPay` server client: payments, webhook endpoints, webhook deliveries, API keys and merchant profile. It
  refuses to run in a browser.
- `PublicClient` for the public checkout endpoints.
- Webhook signature verification (`stellar-pay-sdk/webhooks`, Node.js).
- `formatAmount`, `parseAmount` and `toBigInt` integer-safe amount helpers.
- Typed errors (`StellarPayError`, `StellarPayNetworkError`); ESM and CommonJS builds; no runtime dependencies.
