import { Hono } from 'hono';
import './context/types.js';
import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { opsRoutes } from './routes/ops.js';
import { buildMeRoutes, meRoutes } from './routes/me.js';
import { buildBillRoutes } from './routes/bills.js';
import { buildSessionRoutes } from './routes/sessions.js';
import { buildPaymentGetRoute } from './routes/payments.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import type { IdTokenVerifier } from './services/auth.js';
import type { BillParser } from './services/bills/parser.js';
import { createDefaultBillParser } from './services/bills/geminiParser.js';
import type { PaymentProvider } from './services/payments/provider.js';
import { MockTrueLayerProvider } from './services/payments/mockProvider.js';

export interface AppDeps {
  idTokenVerifier?: IdTokenVerifier;
  billParser?: BillParser;
  paymentProvider?: PaymentProvider;
}

const defaultPaymentProvider = (): PaymentProvider => {
  const secret = env.TRUELAYER_WEBHOOK_SECRET ?? 'local-mock-secret';
  return new MockTrueLayerProvider(secret);
};

export const createApp = (deps: AppDeps = {}): Hono => {
  const app = new Hono();
  const billParser = deps.billParser ?? createDefaultBillParser(env.GEMINI_API_KEY);
  const paymentProvider = deps.paymentProvider ?? defaultPaymentProvider();

  app.use('*', requestId());
  app.use('*', requestLogger());

  app.onError(errorHandler);

  app.route('/', opsRoutes);
  app.route('/v1', deps.idTokenVerifier ? buildMeRoutes(deps.idTokenVerifier) : meRoutes);
  app.route('/v1/bills', buildBillRoutes({ idTokenVerifier: deps.idTokenVerifier, billParser }));
  app.route(
    '/v1/sessions',
    buildSessionRoutes({
      idTokenVerifier: deps.idTokenVerifier,
      paymentProvider,
    }),
  );
  app.route('/v1/payments', buildPaymentGetRoute({ idTokenVerifier: deps.idTokenVerifier }));
  app.route('/webhooks', buildWebhookRoutes({ provider: paymentProvider }));

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
