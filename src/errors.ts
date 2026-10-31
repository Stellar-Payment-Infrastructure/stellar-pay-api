/**
 * Typed API errors with stable codes. Every error response uses the envelope
 * `{ error: { code, message, details? } }`. Messages never include secrets
 * or internal details (stack traces, SQL, RPC payloads).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const validationError = (details: unknown) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', details);
export const unauthorized = (message = 'Missing or invalid API key') =>
  new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (resource: string) => new ApiError(404, 'NOT_FOUND', `${resource} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);
export const tooManyRequests = (retryAfterSec: number) =>
  new ApiError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSec });

/** Contract error codes (stellar-pay-core `Error` enum) mapped to stable API codes. */
export const CONTRACT_ERROR_CODES: Record<number, string> = {
  1: 'CONTRACT_NOT_INITIALIZED',
  2: 'CONTRACT_ALREADY_INITIALIZED',
  3: 'PAYMENT_NOT_FOUND_ON_CHAIN',
  4: 'PAYMENT_ALREADY_EXISTS_ON_CHAIN',
  5: 'CONTRACT_UNAUTHORIZED',
  6: 'INVALID_AMOUNT',
  7: 'INVALID_PAYMENT_STATE',
  8: 'CONTRACT_PAUSED',
  9: 'TOKEN_NOT_ALLOWED',
  10: 'FEE_TOO_HIGH',
  11: 'RECLAIM_TOO_EARLY',
  12: 'ARITHMETIC_OVERFLOW',
  13: 'INVALID_ADDRESS',
};

/** Extracts `N` from host error strings like `Error(Contract, #7)`. */
export function parseContractErrorCode(text: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(text);
  return m?.[1] ? Number(m[1]) : undefined;
}

/** Base class for Soroban interaction failures. */
export class ChainError extends ApiError {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'ChainError';
  }
}

/**
 * The token (Stellar Asset Contract) is called inside `pay`, `settle` and
 * `refund`, and its error numbers overlap ours. These calls cannot raise our
 * codes 10, 11 or 13 themselves, so there those numbers come from the token.
 */
export const PAY_TOKEN_ERRORS: Record<number, string> = {
  10: 'INSUFFICIENT_BALANCE',
  11: 'BALANCE_DEAUTHORIZED',
  13: 'TRUSTLINE_MISSING',
};
export const PAYOUT_TOKEN_ERRORS: Record<number, string> = {
  10: 'TOKEN_BALANCE_ERROR',
  11: 'BALANCE_DEAUTHORIZED',
  13: 'RECIPIENT_TRUSTLINE_MISSING',
};

/** Simulation rejected the transaction (bad state, auth, balance...). */
export class SimulationError extends ChainError {
  constructor(
    public readonly contractErrorCode: number | undefined,
    raw: string,
    overrides: Record<number, string> = {},
  ) {
    const code =
      contractErrorCode !== undefined
        ? (overrides[contractErrorCode] ?? CONTRACT_ERROR_CODES[contractErrorCode] ?? 'CONTRACT_ERROR')
        : 'SIMULATION_FAILED';
    super(
      contractErrorCode !== undefined ? 409 : 400,
      code,
      'Transaction simulation failed',
      contractErrorCode !== undefined ? { contractError: contractErrorCode } : { reason: summarize(raw) },
    );
    this.name = 'SimulationError';
  }
}

/** The network rejected or failed the transaction. */
export class SubmitError extends ChainError {
  constructor(message: string, details?: unknown) {
    super(502, 'SUBMIT_FAILED', message, details);
    this.name = 'SubmitError';
  }
}

/** The transaction did not reach a final state in time. */
export class ChainTimeoutError extends ChainError {
  constructor(public readonly txHash: string) {
    super(504, 'CHAIN_TIMEOUT', 'Timed out waiting for the transaction', { txHash });
    this.name = 'ChainTimeoutError';
  }
}

export class RpcUnavailableError extends ChainError {
  constructor() {
    super(503, 'RPC_UNAVAILABLE', 'Soroban RPC is unavailable');
    this.name = 'RpcUnavailableError';
  }
}

/** Keeps the first line of a host error and strips anything long. */
function summarize(raw: string): string {
  const firstLine = raw.split('\n')[0] ?? '';
  return firstLine.slice(0, 200);
}
