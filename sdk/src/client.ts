import { type FetchLike, HttpClient, randomIdempotencyKey } from './http.js';
import type {
  ApiKey,
  ApiKeyWithSecret,
  CreatePaymentParams,
  CreateWebhookEndpointParams,
  ListPaymentsParams,
  ListWebhookDeliveriesParams,
  Merchant,
  Payment,
  PaymentList,
  Scope,
  UpdateWebhookEndpointParams,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
} from './types.js';

export interface StellarPayOptions {
  /** Secret API key (`sk_test_...`). Server-side only: never ship it to a browser. */
  apiKey: string;
  /** API origin, e.g. `https://api.example.com`. */
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** `amount` may be given as a bigint; it is sent as a decimal string. */
export type CreatePaymentInput = Omit<CreatePaymentParams, 'amount' | 'settleMode'> & {
  amount: bigint | string;
  settleMode?: CreatePaymentParams['settleMode'];
};

/**
 * Server-side client for the Stellar Pay API.
 *
 * ```ts
 * const sp = new StellarPay({ apiKey: process.env.STELLAR_PAY_API_KEY!, baseUrl: 'https://api.example.com' });
 * const payment = await sp.payments.create({ amount: 10_000_000n, reference: 'order-42' });
 * ```
 */
export class StellarPay {
  readonly payments: PaymentsResource;
  readonly webhookEndpoints: WebhookEndpointsResource;
  readonly webhookDeliveries: WebhookDeliveriesResource;
  readonly apiKeys: ApiKeysResource;
  private readonly http: HttpClient;

  constructor(opts: StellarPayOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      // Secret keys must never live in a browser. Use PublicClient there.
      throw new Error('StellarPay (secret key client) must not be used in a browser; use PublicClient');
    }
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      headers: { authorization: `Bearer ${opts.apiKey}` },
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    });
    this.payments = new PaymentsResource(this.http);
    this.webhookEndpoints = new WebhookEndpointsResource(this.http);
    this.webhookDeliveries = new WebhookDeliveriesResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
  }

  /** The merchant that owns the API key. */
  merchant(): Promise<Merchant> {
    return this.http.request('GET', '/v1/merchant');
  }
}

class PaymentsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Creates a payment on-chain. An `Idempotency-Key` is generated
   * automatically; pass your own to make retries across processes safe.
   */
  create(input: CreatePaymentInput, opts: { idempotencyKey?: string } = {}): Promise<Payment> {
    const body = { ...input, amount: typeof input.amount === 'bigint' ? input.amount.toString() : input.amount };
    return this.http.request('POST', '/v1/payments', {
      body,
      headers: { 'idempotency-key': opts.idempotencyKey ?? randomIdempotencyKey() },
    });
  }

  get(id: string): Promise<Payment> {
    return this.http.request('GET', `/v1/payments/${encodeURIComponent(id)}`);
  }

  list(params: Partial<ListPaymentsParams> = {}): Promise<PaymentList> {
    return this.http.request('GET', '/v1/payments', { query: params });
  }

  /** Iterates every payment matching `params`, following cursors. */
  async *listAll(params: Partial<Omit<ListPaymentsParams, 'cursor'>> = {}): AsyncGenerator<Payment> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, ...(cursor ? { cursor } : {}) });
      for (const p of page.data) yield p;
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
  }

  cancel(id: string): Promise<Payment> {
    return this.http.request('POST', `/v1/payments/${encodeURIComponent(id)}/cancel`);
  }

  settle(id: string): Promise<Payment> {
    return this.http.request('POST', `/v1/payments/${encodeURIComponent(id)}/settle`);
  }

  refund(id: string): Promise<Payment> {
    return this.http.request('POST', `/v1/payments/${encodeURIComponent(id)}/refund`);
  }
}

class WebhookEndpointsResource {
  constructor(private readonly http: HttpClient) {}

  /** The returned `secret` is shown only once; store it to verify signatures. */
  create(params: CreateWebhookEndpointParams | { url: string }): Promise<WebhookEndpointWithSecret> {
    return this.http.request('POST', '/v1/webhook-endpoints', { body: params });
  }

  async list(): Promise<WebhookEndpoint[]> {
    return (await this.http.request<{ data: WebhookEndpoint[] }>('GET', '/v1/webhook-endpoints')).data;
  }

  get(id: string): Promise<WebhookEndpoint> {
    return this.http.request('GET', `/v1/webhook-endpoints/${encodeURIComponent(id)}`);
  }

  update(id: string, params: UpdateWebhookEndpointParams): Promise<WebhookEndpoint> {
    return this.http.request('PATCH', `/v1/webhook-endpoints/${encodeURIComponent(id)}`, { body: params });
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/v1/webhook-endpoints/${encodeURIComponent(id)}`);
  }
}

class WebhookDeliveriesResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: Partial<ListWebhookDeliveriesParams> = {}): Promise<WebhookDelivery[]> {
    return (await this.http.request<{ data: WebhookDelivery[] }>('GET', '/v1/webhook-deliveries', { query: params })).data;
  }

  retry(id: string): Promise<WebhookDelivery> {
    return this.http.request('POST', `/v1/webhook-deliveries/${encodeURIComponent(id)}/retry`);
  }
}

class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<ApiKey[]> {
    return (await this.http.request<{ data: ApiKey[] }>('GET', '/v1/api-keys')).data;
  }

  /** The returned `key` is shown only once. */
  create(scopes?: Scope[]): Promise<ApiKeyWithSecret> {
    return this.http.request('POST', '/v1/api-keys', { body: scopes ? { scopes } : {} });
  }

  async revoke(id: string): Promise<void> {
    await this.http.request('DELETE', `/v1/api-keys/${encodeURIComponent(id)}`);
  }
}
