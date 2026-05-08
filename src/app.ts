import { Hono } from 'hono';
import './context/types.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { opsRoutes } from './routes/ops.js';
import { buildMeRoutes, meRoutes } from './routes/me.js';
import type { IdTokenVerifier } from './services/auth.js';

export interface AppDeps {
  idTokenVerifier?: IdTokenVerifier;
}

export const createApp = (deps: AppDeps = {}): Hono => {
  const app = new Hono();

  app.use('*', requestId());
  app.use('*', requestLogger());

  app.onError(errorHandler);

  app.route('/', opsRoutes);
  app.route('/v1', deps.idTokenVerifier ? buildMeRoutes(deps.idTokenVerifier) : meRoutes);

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND' as const,
          message: 'Route not found',
          requestId: c.var.requestId ?? 'unknown',
        },
      },
      404,
    ),
  );

  return app;
};

export const app = createApp();
