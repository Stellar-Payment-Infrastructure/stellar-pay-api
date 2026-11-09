import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import type { Logger } from './logger.js';
import { errorHandler, publicRateLimit, requestContext } from './http/middleware.js';
import { merchantRouter, publicRouter, type RouteDeps } from './http/routes.js';
import { notFound } from './errors.js';
import { buildOpenApiDocument } from './openapi/spec.js';

export interface AppDeps extends RouteDeps {
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext(deps.logger));
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));

  app.get('/v1/health', (_req, res) => {
    res.json({ status: 'ok', network: config.STELLAR_NETWORK, contractId: config.PAY_CONTRACT_ID, time: new Date().toISOString() });
  });

  const spec = buildOpenApiDocument();
  app.get('/v1/openapi.json', (_req, res) => {
    res.json(spec);
  });
  // Swagger UI needs inline scripts/styles; relax CSP for /docs only.
  app.use(
    '/docs',
    helmet({ contentSecurityPolicy: false }),
    swaggerUi.serve,
    swaggerUi.setup(spec, { customSiteTitle: 'Stellar Pay API' }),
  );

  // Public checkout: CORS limited to configured checkout origins.
  app.use(
    '/v1/public',
    cors({ origin: config.corsOrigins.length > 0 ? config.corsOrigins : false, methods: ['GET', 'POST'] }),
    publicRateLimit(config.PUBLIC_RATE_LIMIT_PER_MIN),
    publicRouter(deps),
  );

  // Merchant API: server-to-server only, no CORS.
  // TODO(wave: api-1): mount a GraphQL endpoint here that resolves through the
  // same services (src/payments/service.ts) with the same API-key auth and scopes.
  app.use('/v1', merchantRouter(deps));

  app.use((_req, _res, next) => next(notFound('Route')));
  app.use(errorHandler());
  return app;
}
