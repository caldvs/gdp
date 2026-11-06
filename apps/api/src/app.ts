import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import './context/types.js';
import { env } from './config/env.js';
import { originMatcher, parseOrigins } from './config/allowedOrigins.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { opsRoutes } from './routes/ops.js';
import { docsRoutes } from './routes/docs.js';
import { buildMeRoutes, meRoutes } from './routes/me.js';
import { buildBillRoutes } from './routes/bills.js';
import { buildSessionRoutes } from './routes/sessions.js';
import { buildPaymentGetRoute } from './routes/payments.js';
import { buildAuthRoutes } from './routes/auth.js';
import { testAccountsAllowed } from './services/auth/testAccounts.js';
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
import Stripe from 'stripe';
import {
  createTableFeeService,
  type CreditStore,
  type TableFeeStore,
} from './services/billing/tableFee.js';
import { parseEmailList } from './config/exemptEmails.js';
import {
  creditStore as defaultCreditStore,
  holdIndex,
  tableFeeStore as defaultTableFeeStore,
} from './storage/tableFeeStore.js';
import { sessionStore } from './storage/sessionStore.js';
import { sessionService } from './services/sessions/sessionService.js';
import { runHoldSweep, type HoldSweepReport } from './ops/holdSweep.js';
import { billStore } from './storage/billStore.js';
import { buildBillingRoutes } from './routes/billing.js';
import { buildStripeWebhookRoutes } from './routes/stripeWebhook.js';

export interface AppDeps {
  /** Comma list of allowed browser origins; overrides ALLOWED_ORIGINS (tests). */
  allowedOrigins?: string;
  /** Comma list; overrides TABLE_FEE_EXEMPT_EMAILS (tests). */
  exemptEmails?: string;
  idTokenVerifier?: IdTokenVerifier;
  billParser?: BillParser;
  venueResolver?: VenueResolver;
  emailSender?: EmailSender;
  /** Override the JWT secret for tests (use a deterministic value). */
  sessionJwtSecret?: Uint8Array;
  /** Honour `skipCache` on bill uploads and reads. Defaults to APP_ENV=local. */
  allowSkipCache?: boolean;
  /** LOCAL DEVELOPMENT ONLY: enable POST /v1/auth/email/dev-sign-in. */
  devEmailSignIn?: boolean;
  /**
   * Enable POST /v1/auth/email/test-sign-in (@test.invalid accounts, no
   * code). Defaults to AUTH_TEST_ACCOUNTS. Ignored when APP_ENV=prod.
   */
  testAccountSignIn?: boolean;
  /**
   * Stripe client for the lead's table fee. Omit to build one from
   * STRIPE_SECRET_KEY; pass `null` to leave the billing routes unmounted.
   */
  stripe?: Stripe | null;
  stripeWebhookSecret?: string;
  tableFeeStore?: TableFeeStore;
  /** The free monthly bill. Omit for DynamoDB; `null` turns credits off (every share pays). */
  creditStore?: CreditStore | null;
  /** Clock for the monthly credit, for tests. */
  now?: () => Date;
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
// Service when VENUE_LOOKUP=amazon-location (deployed, and locally from
// .env.example), else used as read.
const defaultVenueResolver = (): VenueResolver =>
  env.VENUE_LOOKUP === 'amazon-location'
    ? new AmazonLocationVenueResolver(amazonLocationSearch(env.AWS_REGION), baseLogger)
    : new NoopVenueResolver();

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
  app.use('*', requestId());
  app.use('*', requestLogger());
  // nosniff, no framing, no referrer, HSTS and friends (#150). The web app
  // calls from another origin, so CORP is left to CORS to decide.
  app.use('*', secureHeaders({ xFrameOptions: 'DENY', crossOriginResourcePolicy: false }));

  // CORS: only the web app's own origins (ALLOWED_ORIGINS, set per stage by
  // CDK). Unset (local) allows any origin.
  const allowed = parseOrigins(deps.allowedOrigins ?? env.ALLOWED_ORIGINS);
  const originAllowed = originMatcher(allowed);
  app.use(
    '*',
    cors({
      origin: allowed.length === 0 ? '*' : (origin) => (originAllowed(origin) ? origin : null),
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
        exemptEmails: parseEmailList(deps.exemptEmails ?? env.TABLE_FEE_EXEMPT_EMAILS),
        testAccountSignIn: testAccountsAllowed(
          env.APP_ENV,
          deps.testAccountSignIn ?? env.AUTH_TEST_ACCOUNTS === 'true',
        ),
      }),
    );
  }
  app.route('/v1', idTokenVerifier ? buildMeRoutes(idTokenVerifier) : meRoutes);
  app.route(
    '/v1/bills',
    buildBillRoutes({
      idTokenVerifier,
      billParser,
      venueResolver,
      reads,
      allowSkipCache: deps.allowSkipCache ?? env.APP_ENV === 'local',
    }),
  );
  // The lead's table fee, paid through Stripe's embedded form.
  const stripe =
    deps.stripe === undefined
      ? env.STRIPE_SECRET_KEY
        ? new Stripe(env.STRIPE_SECRET_KEY)
        : null
      : deps.stripe;
  const tableFees = stripe
    ? createTableFeeService({
        stripe,
        store: deps.tableFeeStore ?? defaultTableFeeStore,
        ...(deps.creditStore === null ? {} : { credits: deps.creditStore ?? defaultCreditStore }),
        ...(deps.now ? { now: deps.now } : {}),
        getBill: (billId) => billStore.getLatest(billId),
        appBaseUrl: env.APP_BASE_URL,
        exemptEmails: parseEmailList(deps.exemptEmails ?? env.TABLE_FEE_EXEMPT_EMAILS),
      })
    : null;

  app.route(
    '/v1/sessions',
    buildSessionRoutes({
      idTokenVerifier,
      ...(sessionJwtSecret ? { jwtSecret: sessionJwtSecret } : {}),
      reports: createReportService({ emailSender }),
      ...(tableFees ? { tableFees } : {}),
    }),
  );
  app.route('/v1/payments', buildPaymentGetRoute({ idTokenVerifier }));

  if (stripe && tableFees) {
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

/**
 * Runs the daily hold sweep (#168, see ops/holdSweep.ts) when EventBridge
 * invokes this Lambda. Throws when a hold couldn't be settled, so the
 * Lambda errors alarm fires; the next day's run tries it again.
 */
export const runHoldSweepNow = async (): Promise<HoldSweepReport | { skipped: string }> => {
  if (!env.STRIPE_SECRET_KEY) return { skipped: 'Stripe not enabled' };
  const tableFees = createTableFeeService({
    stripe: new Stripe(env.STRIPE_SECRET_KEY),
    store: defaultTableFeeStore,
    credits: defaultCreditStore,
    getBill: (billId) => billStore.getLatest(billId),
    appBaseUrl: env.APP_BASE_URL,
  });
  const report = await runHoldSweep({
    holds: holdIndex,
    getFee: (billId) => defaultTableFeeStore.get(billId),
    getSession: (sessionId) => sessionStore.get(sessionId),
    guestsFeePence: (sessionId) => sessionService.guestsFeePence(sessionId),
    tableFees,
  });
  baseLogger.info({ event: 'hold_sweep.done', ...report }, 'Hold sweep');
  if (report.failed.length > 0) {
    throw new Error(`Hold sweep: ${report.failed.length} hold(s) not settled`);
  }
  return report;
};
