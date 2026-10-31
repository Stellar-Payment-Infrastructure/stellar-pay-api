/**
 * Zod schemas for every request and response. They validate input at runtime
 * and are the single source of truth for the OpenAPI document.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { SCOPES } from '../auth/apiKeys.js';
import { PAYMENT_STATUSES } from '../db/schema.js';
import { WEBHOOK_EVENT_TYPES } from '../payments/stateMachine.js';

extendZodWithOpenApi(z);

export { z };

const isoDate = z.string().datetime({ offset: true }).openapi({ example: '2026-01-01T00:00:00.000Z' });
const txHash = z.string().nullable().openapi({ description: 'Transaction hash (hex)' });

export const AmountString = z
  .string()
  .regex(/^[1-9]\d{0,38}$/, 'must be a positive integer string of base units')
  .openapi({ description: 'Amount in token base units, as a decimal string', example: '10000000' });

export const PaymentId = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters')
  .openapi({ description: '32-byte payment id (hex)', example: 'a'.repeat(64) });

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error');

export const PaymentStatus = z.enum(PAYMENT_STATUSES).openapi('PaymentStatus');
export const SettleModeSchema = z.enum(['auto', 'manual']).openapi('SettleMode');

const Metadata = z
  .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, 'at most 20 metadata keys')
  .openapi({ description: 'Merchant key/value data (off-chain only, max 20 keys)' });

export const CreatePaymentBody = z
  .object({
    amount: AmountString,
    token: z.string().optional().openapi({ description: 'Token contract id; must equal the configured token if given' }),
    reference: z.string().min(1).max(128).optional().openapi({ description: 'Merchant reference (off-chain; only a salted hash goes on-chain)' }),
    metadata: Metadata.optional(),
    settleMode: SettleModeSchema.default('manual'),
    successUrl: z.string().url().max(2048).optional(),
    cancelUrl: z.string().url().max(2048).optional(),
  })
  .strict()
  .openapi('CreatePaymentRequest');

export const Payment = z
  .object({
    id: PaymentId,
    object: z.literal('payment'),
    status: PaymentStatus,
    amount: AmountString,
    token: z.string(),
    tokenCode: z.string(),
    decimals: z.number().int(),
    merchantId: z.string().uuid(),
    merchantAddress: z.string(),
    settleMode: SettleModeSchema,
    payer: z.string().nullable(),
    reference: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    successUrl: z.string().nullable(),
    cancelUrl: z.string().nullable(),
    feeBps: z.number().int().nullable(),
    fee: z.string().nullable().openapi({ description: 'Fee in base units (set once settled)' }),
    checkoutUrl: z.string(),
    transactions: z.object({ create: txHash, pay: txHash, settle: txHash, refund: txHash, cancel: txHash }),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .openapi('Payment');

export const PaymentList = z
  .object({
    data: z.array(Payment),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().openapi({ description: 'Pass as `cursor` to get the next page' }),
  })
  .openapi('PaymentList');

export const ListPaymentsQuery = z
  .object({
    status: PaymentStatus.optional(),
    created_gte: isoDate.optional(),
    created_lte: isoDate.optional(),
    updated_since: isoDate.optional().openapi({
      description: 'Return payments updated at or after this time, oldest update first (aggregator feed)',
    }),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const PublicPayment = z
  .object({
    id: PaymentId,
    status: PaymentStatus,
    amount: AmountString,
    token: z.string(),
    tokenCode: z.string(),
    decimals: z.number().int(),
    merchantName: z.string(),
    successUrl: z.string().nullable(),
    cancelUrl: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .openapi('PublicPayment');

export const BuildTransactionBody = z
  .object({ payer: z.string().min(56).max(56).openapi({ description: 'Payer account (G...)' }) })
  .strict()
  .openapi('BuildTransactionRequest');

export const BuildTransactionResponse = z
  .object({
    transactionXdr: z.string().openapi({ description: 'Unsigned, simulated and assembled transaction (base64 XDR)' }),
    networkPassphrase: z.string(),
    validUntil: isoDate,
  })
  .openapi('BuildTransactionResponse');

export const SubmitTransactionBody = z
  .object({ signedXdr: z.string().min(1).max(20_000) })
  .strict()
  .openapi('SubmitTransactionRequest');

export const SubmitTransactionResponse = z
  .object({ transactionHash: z.string(), status: PaymentStatus })
  .openapi('SubmitTransactionResponse');

export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES).openapi('WebhookEventType');

export const CreateWebhookEndpointBody = z
  .object({
    url: z.string().url().max(2048).openapi({ example: 'https://merchant.example/webhooks/stellar-pay' }),
    events: z.array(WebhookEventType).min(1).default([...WEBHOOK_EVENT_TYPES]),
  })
  .strict()
  .openapi('CreateWebhookEndpointRequest');

export const UpdateWebhookEndpointBody = z
  .object({
    url: z.string().url().max(2048).optional(),
    events: z.array(WebhookEventType).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateWebhookEndpointRequest');

export const WebhookEndpoint = z
  .object({
    id: z.string().uuid(),
    object: z.literal('webhook_endpoint'),
    url: z.string(),
    events: z.array(WebhookEventType),
    enabled: z.boolean(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .openapi('WebhookEndpoint');

export const WebhookEndpointWithSecret = WebhookEndpoint.extend({
  secret: z.string().openapi({ description: 'Signing secret. Returned only once, at creation.' }),
}).openapi('WebhookEndpointWithSecret');

export const WebhookEndpointList = z.object({ data: z.array(WebhookEndpoint) }).openapi('WebhookEndpointList');

export const WebhookDelivery = z
  .object({
    id: z.string().uuid(),
    object: z.literal('webhook_delivery'),
    endpointId: z.string().uuid(),
    eventId: z.string(),
    eventType: z.string().nullable(),
    status: z.enum(['pending', 'sending', 'succeeded', 'failed']),
    attempt: z.number().int(),
    nextAttemptAt: isoDate.nullable(),
    responseCode: z.number().int().nullable(),
    responseMs: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .openapi('WebhookDelivery');

export const WebhookDeliveryList = z.object({ data: z.array(WebhookDelivery) }).openapi('WebhookDeliveryList');

export const ListDeliveriesQuery = z
  .object({
    endpoint_id: z.string().uuid().optional(),
    status: z.enum(['pending', 'sending', 'succeeded', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const Merchant = z
  .object({
    id: z.string().uuid(),
    object: z.literal('merchant'),
    name: z.string(),
    displayName: z.string(),
    payoutAddress: z.string(),
    createdAt: isoDate,
  })
  .openapi('Merchant');

export const ScopeSchema = z.enum(SCOPES).openapi('Scope');

export const ApiKey = z
  .object({
    id: z.string().uuid(),
    object: z.literal('api_key'),
    prefix: z.string(),
    scopes: z.array(ScopeSchema),
    createdAt: isoDate,
    lastUsedAt: isoDate.nullable(),
    revokedAt: isoDate.nullable(),
  })
  .openapi('ApiKey');

export const ApiKeyWithSecret = ApiKey.extend({
  key: z.string().openapi({ description: 'The secret key. Returned only once.' }),
}).openapi('ApiKeyWithSecret');

export const ApiKeyList = z.object({ data: z.array(ApiKey) }).openapi('ApiKeyList');

export const CreateApiKeyBody = z
  .object({ scopes: z.array(ScopeSchema).min(1).default([...SCOPES]) })
  .strict()
  .openapi('CreateApiKeyRequest');

export const Health = z
  .object({ status: z.literal('ok'), network: z.string(), contractId: z.string(), time: isoDate })
  .openapi('Health');
