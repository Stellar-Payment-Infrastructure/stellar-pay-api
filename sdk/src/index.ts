export { StellarPay, type CreatePaymentInput, type StellarPayOptions } from './client.js';
export { PublicClient, type PublicClientOptions } from './public.js';
export { StellarPayError, StellarPayNetworkError, type FetchLike } from './http.js';
export { formatAmount, parseAmount, toBigInt } from './amount.js';
export type * from './types.js';

/** Payment statuses after which nothing changes. */
export const TERMINAL_STATUSES = ['settled', 'refunded', 'cancelled', 'failed'] as const;
