import { Hono } from 'hono';
import './context/types.js';
import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { opsRoutes } from './routes/ops.js';
import { buildMeRoutes, meRoutes } from './routes/me.js';
import { buildBillRoutes } from './routes/bills.js';
import type { IdTokenVerifier } from './services/auth.js';
import type { BillParser } from './services/bills/parser.js';
import { createDefaultBillParser } from './services/bills/geminiParser.js';

export interface AppDeps {
  idTokenVerifier?: IdTokenVerifier;
  billParser?: BillParser;
}

export const createApp = (deps: AppDeps = {}): Hono => {
  const app = new Hono();
  const billParser = deps.billParser ?? createDefaultBillParser(env.GEMINI_API_KEY);

  app.use('*', requestId());
  app.use('*', requestLogger());

  app.onError(errorHandler);

  app.route('/', opsRoutes);
  app.route('/v1', deps.idTokenVerifier ? buildMeRoutes(deps.idTokenVerifier) : meRoutes);
  app.route('/v1/bills', buildBillRoutes({ idTokenVerifier: deps.idTokenVerifier, billParser }));

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
