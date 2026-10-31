import { type FetchLike, HttpClient } from './http.js';
import type { BuildTransactionResponse, PublicPayment, SubmitTransactionResponse } from './types.js';

export interface PublicClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Key-less client for the public checkout endpoints. Safe for browsers: it is
 * authorized only by the (unguessable) payment id.
 */
export class PublicClient {
  private readonly http: HttpClient;

  constructor(opts: PublicClientOptions | string) {
    const o = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.http = new HttpClient({ baseUrl: o.baseUrl, fetch: o.fetch, timeoutMs: o.timeoutMs });
  }

  getPayment(id: string): Promise<PublicPayment> {
    return this.http.request('GET', `/v1/public/payments/${encodeURIComponent(id)}`);
  }

  /** Returns the unsigned, prepared `pay` transaction for `payer` to sign. */
  buildTransaction(id: string, payer: string): Promise<BuildTransactionResponse> {
    return this.http.request('POST', `/v1/public/payments/${encodeURIComponent(id)}/transaction`, { body: { payer } });
  }

  /** Submits the payer-signed transaction (base64 XDR). */
  submitTransaction(id: string, signedXdr: string): Promise<SubmitTransactionResponse> {
    return this.http.request('POST', `/v1/public/payments/${encodeURIComponent(id)}/submit`, { body: { signedXdr } });
  }
}
