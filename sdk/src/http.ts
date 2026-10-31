import type { ErrorBody } from './types.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Error returned by the API, mapped from `{ error: { code, message, details? } }`. */
export class StellarPayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(opts: { code: string; message: string; status: number; details?: unknown; requestId?: string }) {
    super(opts.message);
    this.name = 'StellarPayError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }
}

/** The request never produced an HTTP response (DNS, connection, timeout). */
export class StellarPayNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StellarPayNetworkError';
  }
}

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpOptions) {
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    if (!opts.fetch && typeof globalThis.fetch !== 'function') {
      throw new Error('No fetch implementation available; pass `fetch` in the options');
    }
    // Browsers throw "Illegal invocation" if fetch is called with a `this`
    // other than the global object, so never store the bare global function.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.headers,
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new StellarPayNetworkError(controller.signal.aborted ? 'Request timed out' : 'Network request failed', err);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const err = (data as ErrorBody | undefined)?.error;
      throw new StellarPayError({
        code: err?.code ?? `HTTP_${res.status}`,
        message: err?.message ?? (res.statusText || 'Request failed'),
        status: res.status,
        details: err?.details,
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
    }
    return data as T;
  }
}

export function randomIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
