import { Hono } from 'hono';
import { cors } from 'hono/cors';
import './context/types.js';
import { env } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { opsRoutes } from './routes/ops.js';
import { docsRoutes } from './routes/docs.js';
import { buildMeRoutes, meRoutes } from './routes/me.js';
import { buildBillRoutes } from './routes/bills.js';
import { buildSessionRoutes } from './routes/sessions.js';
import { buildPaymentGetRoute } from './routes/payments.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import { buildAuthRoutes } from './routes/auth.js';
import { createSessionTokenVerifier, type IdTokenVerifier } from './services/auth.js';
import { createDefaultEmailSender } from './services/email/factory.js';
import { createReportService } from './services/sessions/reportService.js';
import type { EmailSender } from './services/email/sender.js';
import type { BillParser } from './services/bills/parser.js';
import { createBillParser } from './services/bills/bedrockParser.js';
import { NoopVenueResolver, type VenueResolver } from './services/bills/venueResolver.js';
import {
  AmazonLocationVenueResolver,
  amazonLocationSearch,
} from './services/bills/locationVenueResolver.js';
import {
  createReadRunner,
  createReadService,
  inProcessDispatcher,
  lambdaSelfDispatcher,
  type ReadDispatcher,
  type ReadJob,
} from './services/bills/readService.js';
import { baseLogger } from './logging/logger.js';
import type { PaymentProvider } from './services/payments/provider.js';
import { MockTrueLayerProvider } from './services/payments/mockProvider.js';
import { TrueLayerSandboxProvider } from './services/payments/trueLayerProvider.js';
import Stripe from 'stripe';
import { createTableFeeService, type TableFeeStore } from './services/billing/tableFee.js';
import { tableFeeStore as defaultTableFeeStore } from './storage/tableFeeStore.js';
import { billStore } from './storage/billStore.js';
import { buildBillingRoutes } from './routes/billing.js';
import { buildStripeWebhookRoutes } from './routes/stripeWebhook.js';

export interface AppDeps {
  idTokenVerifier?: IdTokenVerifier;
  billParser?: BillParser;
  venueResolver?: VenueResolver;
  emailSender?: EmailSender;
  /** Override the JWT secret for tests (use a deterministic value). */
  sessionJwtSecret?: Uint8Array;
  /** LOCAL DEVELOPMENT ONLY: enable POST /v1/auth/email/dev-sign-in. */
  devEmailSignIn?: boolean;
  /**
   * Pass a concrete provider for tests. Pass `null` to force manual mode.
   * Omit to fall back to env-driven default.
   */
  paymentProvider?: PaymentProvider | null;
  /**
   * Stripe client for the lead's table fee. Omit to build one from
   * STRIPE_SECRET_KEY; pass `null` to leave the billing routes unmounted.
   */
  stripe?: Stripe | null;
  stripeWebhookSecret?: string;
  tableFeeStore?: TableFeeStore;
  /** How a background bill read is started. Omit: a self-invoke on Lambda, in-process elsewhere. */
  readDispatcher?: ReadDispatcher;
}

const sessionJwtSecretFromEnv = (): Uint8Array => {
  if (!env.SESSION_JWT_SECRET) {
    throw new Error('SESSION_JWT_SECRET not configured');
  }
  return new TextEncoder().encode(env.SESSION_JWT_SECRET);
};

const defaultIdTokenVerifier = (): IdTokenVerifier =>
  createSessionTokenVerifier(sessionJwtSecretFromEnv());

// The venue Bedrock read off the bill, looked up with Amazon Location
// Service when VENUE_LOOKUP=amazon-location (deployed), else used as read.
const defaultVenueResolver = (): VenueResolver =>
  env.VENUE_LOOKUP === 'amazon-location'
    ? new AmazonLocationVenueResolver(amazonLocationSearch(env.AWS_REGION), baseLogger)
    : new NoopVenueResolver();

const defaultPaymentProvider = (): PaymentProvider | null => {
  if (env.PAYMENT_PROVIDER === 'manual') return null;
  if (env.PAYMENT_PROVIDER === 'truelayer') {
    if (
      !env.TRUELAYER_CLIENT_ID ||
      !env.TRUELAYER_CLIENT_SECRET ||
      !env.TRUELAYER_SIGNING_KID ||
      !env.TRUELAYER_SIGNING_PRIVATE_KEY_PEM ||
      !env.TRUELAYER_RETURN_URI
    ) {
      throw new Error(
        'PAYMENT_PROVIDER=truelayer requires TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET, TRUELAYER_SIGNING_KID, TRUELAYER_SIGNING_PRIVATE_KEY_PEM, TRUELAYER_RETURN_URI',
      );
    }
    return new TrueLayerSandboxProvider({
      environment: env.TRUELAYER_ENVIRONMENT,
      clientId: env.TRUELAYER_CLIENT_ID,
      clientSecret: env.TRUELAYER_CLIENT_SECRET,
      signingKid: env.TRUELAYER_SIGNING_KID,
      signingPrivateKeyPem: env.TRUELAYER_SIGNING_PRIVATE_KEY_PEM,
      returnUri: env.TRUELAYER_RETURN_URI,
    });
  }
  const secret = env.TRUELAYER_WEBHOOK_SECRET ?? 'local-mock-secret';
  return new MockTrueLayerProvider(secret);
};

const defaultBillParser = (): BillParser =>
  createBillParser({
    bedrockModelId: env.BEDROCK_MODEL_ID,
    region: env.AWS_REGION,
  });

/**
 * On Lambda the read must run in its own invocation: once the response is
 * sent, this one is frozen. Elsewhere (local dev, tests) it runs in-process.
 */
const defaultReadDispatcher = (run: (job: ReadJob) => Promise<void>): ReadDispatcher => {
  const fn = process.env.AWS_LAMBDA_FUNCTION_NAME;
  return fn ? lambdaSelfDispatcher(fn, env.AWS_REGION) : inProcessDispatcher(run);
};

export const createApp = (deps: AppDeps = {}): Hono => {
  const app = new Hono();
  const billParser = deps.billParser ?? defaultBillParser();
  const venueResolver = deps.venueResolver ?? defaultVenueResolver();
  const runRead = createReadRunner({ parser: billParser, venueResolver });
  const reads = createReadService({
    dispatch: deps.readDispatcher ?? defaultReadDispatcher(runRead),
  });
  const emailSender = deps.emailSender ?? createDefaultEmailSender();
  const sessionJwtSecret =
    deps.sessionJwtSecret ?? (env.SESSION_JWT_SECRET ? sessionJwtSecretFromEnv() : undefined);
  const idTokenVerifier =
    deps.idTokenVerifier ?? (env.SESSION_JWT_SECRET ? defaultIdTokenVerifier() : undefined);
  // `paymentProvider: undefined` (omitted) → use env default (which may itself be null).
  // `paymentProvider: null` → explicit "manual mode" override (used in tests).
  const paymentProvider =
    deps.paymentProvider === undefined ? defaultPaymentProvider() : deps.paymentProvider;

  app.use('*', requestId());
  app.use('*', requestLogger());

  // CORS for browser clients (Expo web dev). Permissive in dev — tighten before prod.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      exposeHeaders: ['x-request-id'],
      maxAge: 600,
    }),
  );

  app.onError(errorHandler);

  app.route('/', opsRoutes);
  app.route('/', docsRoutes);
  if (sessionJwtSecret) {
    app.route(
      '/v1/auth',
      buildAuthRoutes({
        emailSender,
        jwtSecret: sessionJwtSecret,
        devEmailSignIn: deps.devEmailSignIn === true,
      }),
    );
  }
  app.route('/v1', idTokenVerifier ? buildMeRoutes(idTokenVerifier) : meRoutes);
  app.route('/v1/bills', buildBillRoutes({ idTokenVerifier, billParser, venueResolver, reads }));
  app.route(
    '/v1/sessions',
    buildSessionRoutes({
      idTokenVerifier,
      paymentProvider,
      reports: createReportService({ emailSender }),
    }),
  );
  app.route('/v1/payments', buildPaymentGetRoute({ idTokenVerifier }));
  // No webhook route in manual mode — there's no provider sending events.
  if (paymentProvider) {
    app.route('/webhooks', buildWebhookRoutes({ provider: paymentProvider }));
  }

  // The lead's table fee, paid through Stripe's embedded form.
  const stripe =
    deps.stripe === undefined
      ? env.STRIPE_SECRET_KEY
        ? new Stripe(env.STRIPE_SECRET_KEY)
        : null
      : deps.stripe;
  if (stripe) {
    const tableFees = createTableFeeService({
      stripe,
      store: deps.tableFeeStore ?? defaultTableFeeStore,
      getBill: (billId) => billStore.getLatest(billId),
      appBaseUrl: env.APP_BASE_URL,
    });
    app.route('/v1/billing', buildBillingRoutes({ idTokenVerifier, tableFees }));
    const webhookSecret = deps.stripeWebhookSecret ?? env.STRIPE_WEBHOOK_SECRET;
    if (webhookSecret) {
      app.route('/webhooks', buildStripeWebhookRoutes({ stripe, webhookSecret, tableFees }));
    }
  }

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

/** Runs a background bill read sent to this Lambda (see lambda.ts). */
export const runBillRead = createReadRunner({
  parser: defaultBillParser(),
  venueResolver: defaultVenueResolver(),
});
