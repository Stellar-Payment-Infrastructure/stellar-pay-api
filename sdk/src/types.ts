import type { components, operations } from './generated/openapi.js';

type Schemas = components['schemas'];

export type Payment = Schemas['Payment'];
export type PaymentStatus = Schemas['PaymentStatus'];
export type SettleMode = Schemas['SettleMode'];
export type PaymentList = Schemas['PaymentList'];
export type CreatePaymentParams = Schemas['CreatePaymentRequest'];
export type ListPaymentsParams = NonNullable<operations['listPayments']['parameters']['query']>;
export type PublicPayment = Schemas['PublicPayment'];
export type BuildTransactionResponse = Schemas['BuildTransactionResponse'];
export type SubmitTransactionResponse = Schemas['SubmitTransactionResponse'];
export type WebhookEventType = Schemas['WebhookEventType'];
export type WebhookEndpoint = Schemas['WebhookEndpoint'];
export type WebhookEndpointWithSecret = Schemas['WebhookEndpointWithSecret'];
export type CreateWebhookEndpointParams = Schemas['CreateWebhookEndpointRequest'];
export type UpdateWebhookEndpointParams = Schemas['UpdateWebhookEndpointRequest'];
export type WebhookDelivery = Schemas['WebhookDelivery'];
export type ListWebhookDeliveriesParams = NonNullable<operations['listWebhookDeliveries']['parameters']['query']>;
export type Merchant = Schemas['Merchant'];
export type ApiKey = Schemas['ApiKey'];
export type ApiKeyWithSecret = Schemas['ApiKeyWithSecret'];
export type Scope = Schemas['Scope'];
export type ErrorBody = Schemas['Error'];

/** A webhook event as delivered to your endpoint (and returned by `webhooks.verify`). */
export interface WebhookEvent {
  id: string;
  object: 'event';
  type: WebhookEventType;
  created: number;
  data: { payment: Payment };
}

export type { components, operations, paths } from './generated/openapi.js';
