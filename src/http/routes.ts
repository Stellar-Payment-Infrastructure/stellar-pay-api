import { Router } from 'express';
import { generateApiKey, type Scope } from '../auth/apiKeys.js';
import * as repo from '../db/repo.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import * as payments from '../payments/service.js';
import { encryptSecret, generateWebhookSecret } from '../webhooks/crypto.js';
import { assertSafeWebhookUrl, type Resolver } from '../webhooks/ssrf.js';
import { asyncHandler, auth, idempotency, parse, requireApiKey, requireScope } from './middleware.js';
import * as S from './schemas.js';

export interface RouteDeps extends payments.Deps {
  resolver?: Resolver;
}

function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: ts.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): { ts: Date; id: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    const ts = new Date(String(v.t));
    if (typeof v.id !== 'string' || Number.isNaN(ts.getTime())) throw new Error('bad');
    return { ts, id: v.id };
  } catch {
    throw badRequest('INVALID_CURSOR', 'cursor is malformed');
  }
}

const paymentIdParam = (raw: string | undefined) => {
  const r = S.PaymentId.safeParse(raw);
  if (!r.success) throw notFound('Payment');
  return r.data;
};

const uuidParam = (raw: string | undefined, resource: string) => {
  const r = S.z.string().uuid().safeParse(raw);
  if (!r.success) throw notFound(resource);
  return r.data;
};

function endpointResource(e: repo.WebhookEndpointRow) {
  return {
    id: e.id,
    object: 'webhook_endpoint' as const,
    url: e.url,
    events: e.events,
    enabled: e.enabled,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function apiKeyResource(k: repo.ApiKeyRow) {
  return {
    id: k.id,
    object: 'api_key' as const,
    prefix: k.prefix,
    scopes: k.scopes,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}

/** Routes behind a secret API key (`/v1/...`). */
export function merchantRouter(deps: RouteDeps): Router {
  const { db, config } = deps;
  const r = Router();
  r.use(requireApiKey(db, config.API_KEY_PEPPER));
  const policy = { allowInsecure: config.WEBHOOK_ALLOW_INSECURE };

  // ------------------------------------------------------------- payments
  r.post(
    '/payments',
    requireScope('payments:write'),
    idempotency(db, { required: true }),
    asyncHandler(async (req, res) => {
      const body = parse(S.CreatePaymentBody, req.body);
      if (body.token !== undefined && body.token !== config.PAY_TOKEN_CONTRACT_ID) {
        throw badRequest('TOKEN_NOT_ALLOWED', 'Only the configured token is accepted', { token: config.PAY_TOKEN_CONTRACT_ID });
      }
      const { payment, confirmed } = await payments.createPayment(deps, auth(req).merchant, {
        amount: BigInt(body.amount),
        reference: body.reference,
        metadata: body.metadata,
        settleMode: body.settleMode,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });
      res.status(confirmed ? 201 : 202).json(payments.toPaymentResource(payment, config));
    }),
  );

  r.get(
    '/payments',
    requireScope('payments:read'),
    asyncHandler(async (req, res) => {
      const q = parse(S.ListPaymentsQuery, req.query);
      const rows = await repo.listPayments(db, {
        merchantId: auth(req).merchant.id,
        status: q.status,
        createdGte: q.created_gte ? new Date(q.created_gte) : undefined,
        createdLte: q.created_lte ? new Date(q.created_lte) : undefined,
        updatedSince: q.updated_since ? new Date(q.updated_since) : undefined,
        limit: q.limit,
        after: q.cursor ? decodeCursor(q.cursor) : undefined,
      });
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(q.updated_since ? last.updatedAt : last.createdAt, last.id) : null;
      res.json({ data: page.map((p) => payments.toPaymentResource(p, config)), hasMore, nextCursor });
    }),
  );

  r.get(
    '/payments/:id',
    requireScope('payments:read'),
    asyncHandler(async (req, res) => {
      const p = await payments.getMerchantPayment(db, auth(req).merchant, paymentIdParam(req.params['id']));
      res.json(payments.toPaymentResource(p, config));
    }),
  );

  for (const action of ['cancel', 'settle', 'refund'] as const) {
    r.post(
      `/payments/:id/${action}`,
      requireScope('payments:write'),
      asyncHandler(async (req, res) => {
        const p = await payments.operatorAction(deps, auth(req).merchant, paymentIdParam(req.params['id']), action);
        res.json(payments.toPaymentResource(p, config));
      }),
    );
  }

  // ----------------------------------------------------- webhook endpoints
  r.post(
    '/webhook-endpoints',
    requireScope('webhooks:write'),
    asyncHandler(async (req, res) => {
      const body = parse(S.CreateWebhookEndpointBody, req.body);
      await assertSafeWebhookUrl(body.url, policy, deps.resolver);
      const secret = generateWebhookSecret();
      const row = await repo.insertWebhookEndpoint(db, {
        merchantId: auth(req).merchant.id,
        url: body.url,
        secretEnc: encryptSecret(secret, config.WEBHOOK_SECRET_ENC_KEY),
        events: [...new Set(body.events)],
      });
      res.status(201).json({ ...endpointResource(row), secret });
    }),
  );

  r.get(
    '/webhook-endpoints',
    requireScope('webhooks:read'),
    asyncHandler(async (req, res) => {
      const rows = await repo.listWebhookEndpoints(db, auth(req).merchant.id);
      res.json({ data: rows.map(endpointResource) });
    }),
  );

  r.get(
    '/webhook-endpoints/:id',
    requireScope('webhooks:read'),
    asyncHandler(async (req, res) => {
      const row = await repo.findWebhookEndpoint(db, auth(req).merchant.id, uuidParam(req.params['id'], 'Webhook endpoint'));
      if (!row) throw notFound('Webhook endpoint');
      res.json(endpointResource(row));
    }),
  );

  r.patch(
    '/webhook-endpoints/:id',
    requireScope('webhooks:write'),
    asyncHandler(async (req, res) => {
      const body = parse(S.UpdateWebhookEndpointBody, req.body);
      const id = uuidParam(req.params['id'], 'Webhook endpoint');
      const merchantId = auth(req).merchant.id;
      const row = await repo.findWebhookEndpoint(db, merchantId, id);
      if (!row) throw notFound('Webhook endpoint');
      if (body.url) await assertSafeWebhookUrl(body.url, policy, deps.resolver);
      const updated = await repo.updateWebhookEndpoint(db, merchantId, id, {
        ...(body.url ? { url: body.url } : {}),
        ...(body.events ? { events: [...new Set(body.events)] } : {}),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      if (!updated) throw notFound('Webhook endpoint');
      res.json(endpointResource(updated));
    }),
  );

  r.delete(
    '/webhook-endpoints/:id',
    requireScope('webhooks:write'),
    asyncHandler(async (req, res) => {
      const ok = await repo.deleteWebhookEndpoint(db, auth(req).merchant.id, uuidParam(req.params['id'], 'Webhook endpoint'));
      if (!ok) throw notFound('Webhook endpoint');
      res.status(204).end();
    }),
  );

  // ----------------------------------------------------- webhook deliveries
  r.get(
    '/webhook-deliveries',
    requireScope('webhooks:read'),
    asyncHandler(async (req, res) => {
      const q = parse(S.ListDeliveriesQuery, req.query);
      const rows = await repo.listDeliveries(db, { merchantId: auth(req).merchant.id, endpointId: q.endpoint_id, status: q.status, limit: q.limit });
      const out = [];
      for (const d of rows) out.push(await deliveryResource(deps, d));
      res.json({ data: out });
    }),
  );

  r.post(
    '/webhook-deliveries/:id/retry',
    requireScope('webhooks:write'),
    asyncHandler(async (req, res) => {
      const merchantId = auth(req).merchant.id;
      const d = await repo.findDelivery(db, merchantId, uuidParam(req.params['id'], 'Webhook delivery'));
      if (!d) throw notFound('Webhook delivery');
      if (d.status === 'sending') throw new ApiError(409, 'DELIVERY_IN_PROGRESS', 'Delivery is being sent right now');
      const updated = await repo.updateDelivery(db, d.id, { status: 'pending', nextAttemptAt: new Date(), lockedUntil: null });
      if (!updated) throw notFound('Webhook delivery');
      res.json(await deliveryResource(deps, updated));
    }),
  );

  // ---------------------------------------------------------- merchant/keys
  r.get(
    '/merchant',
    asyncHandler(async (req, res) => {
      const m = auth(req).merchant;
      res.json({ id: m.id, object: 'merchant', name: m.name, displayName: m.displayName, payoutAddress: m.payoutAddress, createdAt: m.createdAt.toISOString() });
    }),
  );

  r.get(
    '/api-keys',
    asyncHandler(async (req, res) => {
      const rows = await repo.listApiKeys(db, auth(req).merchant.id);
      res.json({ data: rows.map(apiKeyResource) });
    }),
  );

  r.post(
    '/api-keys',
    asyncHandler(async (req, res) => {
      const body = parse(S.CreateApiKeyBody, req.body);
      const ctx = auth(req);
      const scopes = [...new Set(body.scopes)] as Scope[];
      // A key can never mint a key with more power than itself.
      if (scopes.some((s) => !ctx.scopes.includes(s))) throw forbidden('Cannot grant scopes the current key does not have');
      const { key, prefix, hash } = generateApiKey(config.API_KEY_PEPPER);
      const row = await repo.insertApiKey(db, { merchantId: ctx.merchant.id, prefix, hash, scopes });
      res.status(201).json({ ...apiKeyResource(row), key });
    }),
  );

  r.delete(
    '/api-keys/:id',
    asyncHandler(async (req, res) => {
      const ok = await repo.revokeApiKey(db, auth(req).merchant.id, uuidParam(req.params['id'], 'API key'));
      if (!ok) throw notFound('API key');
      res.status(204).end();
    }),
  );

  return r;
}

async function deliveryResource(deps: RouteDeps, d: repo.WebhookDeliveryRow) {
  const event = await repo.findPaymentEvent(deps.db, d.eventId);
  return {
    id: d.id,
    object: 'webhook_delivery' as const,
    endpointId: d.endpointId,
    eventId: d.eventId,
    eventType: event?.type ?? null,
    status: d.status,
    attempt: d.attempt,
    nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
    responseCode: d.responseCode,
    responseMs: d.responseMs,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** Public checkout routes (`/v1/public/...`): no key, authorized by the unguessable payment id. */
export function publicRouter(deps: RouteDeps): Router {
  const r = Router();
  r.get(
    '/payments/:id',
    asyncHandler(async (req, res) => {
      res.json(await payments.getPublicPayment(deps, paymentIdParam(req.params['id'])));
    }),
  );
  r.post(
    '/payments/:id/transaction',
    asyncHandler(async (req, res) => {
      const body = parse(S.BuildTransactionBody, req.body);
      res.json(await payments.buildPayTransaction(deps, paymentIdParam(req.params['id']), body.payer));
    }),
  );
  r.post(
    '/payments/:id/submit',
    asyncHandler(async (req, res) => {
      const body = parse(S.SubmitTransactionBody, req.body);
      res.json(await payments.submitPayTransaction(deps, paymentIdParam(req.params['id']), body.signedXdr));
    }),
  );
  return r;
}
