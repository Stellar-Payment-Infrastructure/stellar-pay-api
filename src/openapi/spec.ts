import { OpenApiGeneratorV3, OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import * as S from '../http/schemas.js';

const json = <T extends S.z.ZodTypeAny>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const err = (description: string) => json(S.ErrorResponse, description);

const idParam = S.z.object({ id: S.PaymentId });
const uuidParam = S.z.object({ id: S.z.string().uuid() });
const idempotencyHeader = S.z.object({
  'idempotency-key': S.z.string().min(1).max(255).openapi({ description: 'Required. Retries with the same key and body return the original response.' }),
});

/** Builds the OpenAPI 3.0 document from the same Zod schemas the routes validate with. */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'secretKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'Secret API key (`sk_test_...`). Server-to-server only; never use it in a browser.',
  });
  const secured = { security: [{ secretKey: [] }] };
  const add = (r: RouteConfig) => registry.registerPath(r);
  const common = { 401: err('Missing or invalid API key'), 403: err('API key lacks the required scope') };

  add({
    method: 'get', path: '/v1/health', operationId: 'getHealth', tags: ['ops'], summary: 'Health check',
    responses: { 200: json(S.Health, 'Service is up') },
  });

  add({
    method: 'post', path: '/v1/payments', operationId: 'createPayment', tags: ['payments'], summary: 'Create a payment', ...secured,
    description: 'Creates the payment on-chain (`create_payment`, operator-signed). Returns 201 once confirmed, or 202 with status `pending` if the chain outcome is not known yet.',
    request: { headers: idempotencyHeader, body: { content: { 'application/json': { schema: S.CreatePaymentBody } } } },
    responses: {
      201: json(S.Payment, 'Created on-chain'),
      202: json(S.Payment, 'Accepted; on-chain confirmation pending'),
      400: err('Validation error'),
      ...common,
      409: err('Contract rejected the call or idempotency key in progress'),
      422: err('Idempotency-Key reused with a different body'),
    },
  });
  add({
    method: 'get', path: '/v1/payments', operationId: 'listPayments', tags: ['payments'], summary: 'List payments', ...secured,
    request: { query: S.ListPaymentsQuery },
    responses: { 200: json(S.PaymentList, 'A page of payments'), 400: err('Validation error'), ...common },
  });
  add({
    method: 'get', path: '/v1/payments/{id}', operationId: 'getPayment', tags: ['payments'], summary: 'Get a payment', ...secured,
    request: { params: idParam },
    responses: { 200: json(S.Payment, 'The payment'), ...common, 404: err('Not found') },
  });
  for (const [action, from] of [['cancel', 'created'], ['settle', 'paid'], ['refund', 'paid']] as const) {
    add({
      method: 'post', path: `/v1/payments/{id}/${action}`, operationId: `${action}Payment`, tags: ['payments'], summary: `${action[0]?.toUpperCase()}${action.slice(1)} a payment`, ...secured,
      description: `Operator action. Allowed from status \`${from}\`.`,
      request: { params: idParam },
      responses: { 200: json(S.Payment, 'Updated payment'), ...common, 404: err('Not found'), 409: err('Payment is not in the required state') },
    });
  }

  add({
    method: 'get', path: '/v1/public/payments/{id}', operationId: 'getPublicPayment', tags: ['public checkout'], summary: 'Minimal checkout view',
    description: 'No API key. Authorized by the unguessable payment id. Rate-limited per IP.',
    request: { params: idParam },
    responses: { 200: json(S.PublicPayment, 'Checkout view'), 404: err('Not found'), 429: err('Rate limited') },
  });
  add({
    method: 'post', path: '/v1/public/payments/{id}/transaction', operationId: 'buildPayTransaction', tags: ['public checkout'], summary: 'Build the unsigned pay transaction',
    request: { params: idParam, body: { content: { 'application/json': { schema: S.BuildTransactionBody } } } },
    responses: {
      200: json(S.BuildTransactionResponse, 'Prepared transaction for the payer to sign'),
      400: err('Invalid payer or payer account missing'),
      404: err('Not found'),
      409: err('Payment not payable or simulation rejected by the contract'),
      429: err('Rate limited'),
    },
  });
  add({
    method: 'post', path: '/v1/public/payments/{id}/submit', operationId: 'submitPayTransaction', tags: ['public checkout'], summary: 'Submit the signed pay transaction',
    description: 'The envelope must be exactly one invocation of this contract\'s `pay(payer, id)` with the payer as source and signer. Anything else is rejected with `INVALID_TRANSACTION`.',
    request: { params: idParam, body: { content: { 'application/json': { schema: S.SubmitTransactionBody } } } },
    responses: {
      200: json(S.SubmitTransactionResponse, 'Submitted and confirmed'),
      400: err('Transaction rejected by verification'),
      404: err('Not found'),
      409: err('Payment not payable'),
      429: err('Rate limited'),
      502: err('Network rejected the transaction'),
      504: err('Timed out waiting for confirmation'),
    },
  });

  add({
    method: 'post', path: '/v1/webhook-endpoints', operationId: 'createWebhookEndpoint', tags: ['webhooks'], summary: 'Create a webhook endpoint', ...secured,
    description: 'HTTPS only; hosts resolving to private, loopback, link-local or metadata addresses are rejected. The signing secret is returned once.',
    request: { body: { content: { 'application/json': { schema: S.CreateWebhookEndpointBody } } } },
    responses: { 201: json(S.WebhookEndpointWithSecret, 'Created'), 400: err('Invalid or disallowed URL'), ...common },
  });
  add({
    method: 'get', path: '/v1/webhook-endpoints', operationId: 'listWebhookEndpoints', tags: ['webhooks'], summary: 'List webhook endpoints', ...secured,
    responses: { 200: json(S.WebhookEndpointList, 'Endpoints'), ...common },
  });
  add({
    method: 'get', path: '/v1/webhook-endpoints/{id}', operationId: 'getWebhookEndpoint', tags: ['webhooks'], summary: 'Get a webhook endpoint', ...secured,
    request: { params: uuidParam },
    responses: { 200: json(S.WebhookEndpoint, 'Endpoint'), ...common, 404: err('Not found') },
  });
  add({
    method: 'patch', path: '/v1/webhook-endpoints/{id}', operationId: 'updateWebhookEndpoint', tags: ['webhooks'], summary: 'Update a webhook endpoint', ...secured,
    request: { params: uuidParam, body: { content: { 'application/json': { schema: S.UpdateWebhookEndpointBody } } } },
    responses: { 200: json(S.WebhookEndpoint, 'Updated'), 400: err('Invalid or disallowed URL'), ...common, 404: err('Not found') },
  });
  add({
    method: 'delete', path: '/v1/webhook-endpoints/{id}', operationId: 'deleteWebhookEndpoint', tags: ['webhooks'], summary: 'Delete a webhook endpoint', ...secured,
    request: { params: uuidParam },
    responses: { 204: { description: 'Deleted' }, ...common, 404: err('Not found') },
  });
  add({
    method: 'get', path: '/v1/webhook-deliveries', operationId: 'listWebhookDeliveries', tags: ['webhooks'], summary: 'Delivery log', ...secured,
    request: { query: S.ListDeliveriesQuery },
    responses: { 200: json(S.WebhookDeliveryList, 'Deliveries, newest first'), ...common },
  });
  add({
    method: 'post', path: '/v1/webhook-deliveries/{id}/retry', operationId: 'retryWebhookDelivery', tags: ['webhooks'], summary: 'Retry a delivery now', ...secured,
    request: { params: uuidParam },
    responses: { 200: json(S.WebhookDelivery, 'Rescheduled'), ...common, 404: err('Not found'), 409: err('Delivery in progress') },
  });

  add({
    method: 'get', path: '/v1/merchant', operationId: 'getMerchant', tags: ['merchant'], summary: 'The authenticated merchant', ...secured,
    responses: { 200: json(S.Merchant, 'Merchant'), ...common },
  });
  add({
    method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['merchant'], summary: 'List API keys', ...secured,
    responses: { 200: json(S.ApiKeyList, 'Keys (no secrets)'), ...common },
  });
  add({
    method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['merchant'], summary: 'Create an API key', ...secured,
    description: 'The new key can only have scopes the calling key has. The secret is returned once.',
    request: { body: { content: { 'application/json': { schema: S.CreateApiKeyBody } } } },
    responses: { 201: json(S.ApiKeyWithSecret, 'Created'), ...common },
  });
  add({
    method: 'delete', path: '/v1/api-keys/{id}', operationId: 'revokeApiKey', tags: ['merchant'], summary: 'Revoke an API key', ...secured,
    request: { params: uuidParam },
    responses: { 204: { description: 'Revoked' }, ...common, 404: err('Not found') },
  });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Stellar Pay API',
      version: '0.1.0',
      description:
        'REST API for Stellar Pay (testnet). Amounts are decimal strings of token base units. Errors use `{ error: { code, message, details? } }`.',
      license: { name: 'MIT' },
    },
    servers: [{ url: '/' }],
  });
}

export function serializeOpenApi(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
