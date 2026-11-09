# stellar-pay-sdk

**Status: testnet only · v0.1.0.**

TypeScript client for the [Stellar Pay API](https://github.com/Stellar-Payment-Infrastructure/stellar-pay-api):
typed calls generated from its OpenAPI spec, webhook signature verification, and integer-safe amount helpers.
ESM and CommonJS, no runtime dependencies.

```bash
npm install stellar-pay-sdk
```

## Server: create and manage payments

`StellarPay` uses a **secret API key** and refuses to run in a browser.

```ts
import { StellarPay, StellarPayError } from 'stellar-pay-sdk';

const sp = new StellarPay({ apiKey: process.env.STELLAR_PAY_API_KEY!, baseUrl: 'https://api.example.com' });

// Amounts are integer base units (bigint or decimal string). 1 XLM = 10_000_000 stroops.
const payment = await sp.payments.create({ amount: 10_000_000n, reference: 'order-42' });
// Send the payer to payment.checkoutUrl. An Idempotency-Key is added for you;
// pass { idempotencyKey } to make retries across processes safe.

try {
  await sp.payments.settle(payment.id); // Manual-settle payments only
} catch (err) {
  if (err instanceof StellarPayError) console.error(err.status, err.code, err.requestId);
}

const page = await sp.payments.list({ limit: 50 });
await sp.webhookEndpoints.create({ url: 'https://shop.example.com/webhooks/stellar-pay' }); // returns the secret once
```

Resources: `payments` (create, get, list, settle, cancel, refund), `webhookEndpoints` (create, list, get, update,
delete), `webhookDeliveries` (list, retry), `apiKeys` (list, create, revoke), and `merchant()`.

## Browser: checkout

`PublicClient` calls only the public checkout endpoints, which need no key.

```ts
import { PublicClient } from 'stellar-pay-sdk';

const pub = new PublicClient({ baseUrl: 'https://api.example.com' });
const p = await pub.getPayment(paymentId);
const { transactionXdr, networkPassphrase } = await pub.buildTransaction(paymentId, payerAddress);
// ...the payer's wallet signs transactionXdr...
const { status } = await pub.submitTransaction(paymentId, signedXdr);
```

## Webhooks (Node.js)

Verify against the **raw** request body. Delivery is at-least-once, so deduplicate by `event.id`.

```ts
import { webhooks } from 'stellar-pay-sdk/webhooks';

// rawBody MUST be the unparsed request body (string or Buffer)
const event = webhooks.verify(rawBody, req.headers['stellar-pay-signature'], process.env.WH_SECRET!, { toleranceSec: 300 });
// dedupe by event.id, then handle event.type:
// payment.created | payment.paid | payment.settled | payment.refunded | payment.cancelled
```

`verify` throws `WebhookVerificationError` for a missing or malformed header, a timestamp outside the tolerance, or
a signature mismatch.

## Amounts

```ts
import { formatAmount, parseAmount } from 'stellar-pay-sdk';

formatAmount('10000000', 7); // "1"
parseAmount('1.5', 7);       // 15000000n
```

Never use JavaScript numbers for money: the API sends amounts as decimal strings.

## Compatibility

| stellar-pay-sdk | Stellar Pay API | Node |
|---|---|---|
| 0.1.x | `/v1` (stellar-pay-api 0.1.x) | 20+ (webhooks use `node:crypto`) |

The SDK's types are generated from `openapi.json`, which ships in the package.

## License

[MIT](LICENSE)
