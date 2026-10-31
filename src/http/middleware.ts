import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { hashApiKey, hashesEqual, LOOKUP_PREFIX_LENGTH, looksLikeApiKey, type Scope } from '../auth/apiKeys.js';
import type { Db } from '../db/client.js';
import * as repo from '../db/repo.js';
import { ApiError, badRequest, forbidden, tooManyRequests, unauthorized, unprocessable, validationError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface AuthContext {
  merchant: repo.MerchantRow;
  apiKeyId: string;
  scopes: Scope[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
      auth?: AuthContext;
      log?: Logger;
    }
  }
}

/** Wraps an async handler so rejections reach the error middleware (Express 4). */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Request id (accepted from a sane `X-Request-Id`, otherwise generated) and a child logger. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.log = logger.child({ requestId: req.id });
    const started = Date.now();
    res.on('finish', () => {
      req.log?.info(
        { method: req.method, path: req.route ? `${req.baseUrl}${String(req.route.path)}` : req.path, status: res.statusCode, ms: Date.now() - started },
        'request',
      );
    });
    next();
  };
}

/** Secret API key authentication: prefix lookup + constant-time hash compare. */
export function requireApiKey(db: Db, pepper: string): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    const key = m?.[1]?.trim() ?? '';
    if (!looksLikeApiKey(key)) throw unauthorized();
    const candidates = await repo.findActiveKeysByPrefix(db, key.slice(0, LOOKUP_PREFIX_LENGTH));
    const hash = hashApiKey(key, pepper);
    const match = candidates.find((c) => hashesEqual(c.hash, hash));
    if (!match) throw unauthorized();
    const merchant = await repo.findMerchant(db, match.merchantId);
    if (!merchant) throw unauthorized();
    req.auth = { merchant, apiKeyId: match.id, scopes: match.scopes as Scope[] };
    req.log = req.log?.child({ merchantId: merchant.id });
    repo.touchApiKey(db, match.id).catch(() => undefined);
    next();
  });
}

export function requireScope(scope: Scope): RequestHandler {
  return (req, _res, next) => {
    if (!auth(req).scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
    next();
  };
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * `Idempotency-Key` handling for creating POSTs. The first request claims the
 * key; a retry with the same key and body gets the stored response; the same
 * key with a different body is rejected; a retry while the first is still in
 * flight gets 409. Failed (non-2xx) first attempts release the key.
 */
export function idempotency(db: Db, opts: { required: boolean }): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const key = req.header('idempotency-key');
    if (!key) {
      if (opts.required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
      return next();
    }
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-255 printable characters');
    const { merchant } = auth(req);
    const requestHash = createHash('sha256').update(`${req.method} ${req.originalUrl}\n${stableStringify(req.body ?? null)}`).digest('hex');
    const claim = await repo.claimIdempotencyKey(db, { merchantId: merchant.id, key, method: req.method, path: req.originalUrl, requestHash });
    if (!claim.claimed) {
      const prev = claim.existing;
      if (prev.requestHash !== requestHash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      if (prev.responseStatus === null) {
        throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still in progress');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(prev.responseStatus).json(prev.responseBody);
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const done = status < 400 ? repo.completeIdempotencyKey(db, merchant.id, key, status, body) : repo.releaseIdempotencyKey(db, merchant.id, key);
      done.catch((err: Error) => req.log?.error({ err: err.message }, 'idempotency bookkeeping failed'));
      return originalJson(body);
    };
    next();
  });
}

/**
 * Naive fixed-window in-memory limiter for public routes, keyed by client IP.
 * Single-instance only.
 * TODO(wave: api-2): per-API-key limits, Redis-backed store, RateLimit-* headers.
 */
export function publicRateLimit(perMinute: number): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = Date.now();
  return (req, _res, next) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
      lastSweep = now;
    }
    const ip = req.ip ?? 'unknown';
    const w = windows.get(ip);
    if (!w || now - w.start >= 60_000) {
      windows.set(ip, { start: now, count: 1 });
      return next();
    }
    if (w.count >= perMinute) throw tooManyRequests(Math.ceil((w.start + 60_000 - now) / 1000));
    w.count++;
    next();
  };
}

/** Error envelope. Unknown errors become a generic 500 without internals. */
export function errorHandler(): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log?.error({ code: err.code, details: err.details }, err.message);
      if (err.status === 429) {
        const d = err.details as { retryAfterSec?: number } | undefined;
        if (d?.retryAfterSec) res.setHeader('Retry-After', String(d.retryAfterSec));
      }
      res.status(err.status).json(err.toJSON());
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json(validationError(err.issues).toJSON());
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') {
      res.status(413).json(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large').toJSON());
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(badRequest('INVALID_JSON', 'Request body is not valid JSON').toJSON());
      return;
    }
    req.log?.error({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, 'unhandled error');
    res.status(500).json(new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred').toJSON());
  };
}
