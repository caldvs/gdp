import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Which environment this is. NODE_ENV says how Node and libraries behave;
  // APP_ENV says which stage's data, keys and rules apply. Deployed Lambdas
  // run NODE_ENV=production with APP_ENV=dev or prod.
  APP_ENV: z.enum(['local', 'dev', 'prod']).default('local'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  AWS_REGION: z.string().default('eu-west-2'),
  DYNAMODB_ENDPOINT: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  DDB_TABLE_NAME: z.string().default('gdp-dev'),
  S3_BUCKET_BILLS: z.string().default('gdp-bills-raw-dev'),

  // HS256 secret used to mint + verify session JWTs after a successful
  // email-OTP verify. Set via CDK from Secrets Manager. Optional only so
  // local dev / tests can wire a deterministic value via AppDeps.
  SESSION_JWT_SECRET: z.string().min(16).optional(),

  // Bedrock model (or inference profile) that reads bills, on the AWS
  // credentials in use. Unset, bill reading fails with a clear error.
  BEDROCK_MODEL_ID: z.string().optional(),
  // How the venue read off the bill is looked up. `amazon-location` fills in
  // the full address and coordinates (Amazon Location Service, cached for
  // good in VENUEQ# rows); `none` keeps the text on the bill. Deployed
  // stacks use amazon-location.
  VENUE_LOOKUP: z.enum(['none', 'amazon-location']).default('none'),

  // Verified SES sender address. When unset, transactional email is
  // logged to stdout via ConsoleEmailSender instead of being sent.
  // For dev the value comes from SSM (/gdp-{env}/ses-from-email),
  // pre-verified once via `aws ses verify-email-identity`.
  SES_FROM_EMAIL: z.string().email().optional(),

  TRUELAYER_CLIENT_ID: z.string().optional(),
  TRUELAYER_CLIENT_SECRET: z.string().optional(),
  TRUELAYER_WEBHOOK_SECRET: z.string().optional(),
  TRUELAYER_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
  TRUELAYER_SIGNING_KID: z.string().optional(),
  TRUELAYER_SIGNING_PRIVATE_KEY_PEM: z.string().optional(),
  TRUELAYER_RETURN_URI: z.string().url().optional(),

  // Test accounts (@test.invalid, sign in with no code) for trying the app
  // as several people. CDK sets it to true for dev only; app.ts ignores it
  // in prod and the dependency check fails if it's on there.
  AUTH_TEST_ACCOUNTS: z.enum(['true', 'false']).default('false'),

  PAYMENT_PROVIDER: z.enum(['mock', 'truelayer', 'manual']).default('mock'),

  // Stripe takes the lead's table fee (not diner money). Both optional:
  // without STRIPE_SECRET_KEY the billing and Stripe webhook routes aren't
  // mounted. For dev the values come from SSM per stage.
  STRIPE_SECRET_KEY: z.string().optional().transform(unwrapSecret),
  STRIPE_WEBHOOK_SECRET: z.string().optional().transform(unwrapSecret),
  // Where the web app lives; Stripe sends the lead back here if a payment
  // method needs a redirect (most don't: cards and wallets complete in place).
  APP_BASE_URL: z.string().url().default('http://localhost:8081'),
  // Comma list of browser origins allowed to call the API (see
  // allowedOrigins.ts). Unset allows any origin, for local dev only.
  ALLOWED_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  throw new Error('Invalid environment configuration');
}

/**
 * Secrets Manager's console saves a secret as `{"<name>":"<value>"}` when
 * it's entered on the Key/value tab rather than Plaintext. Accept either:
 * a one-entry JSON object gives its value, anything else is used as is.
 */
function unwrapSecret(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v?.startsWith('{')) return v;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length === 1 && typeof values[0] === 'string') return values[0].trim();
    }
  } catch {
    /* not JSON: use as is */
  }
  return v;
}

export const env: Env = parsed.data;

export const isProd = env.APP_ENV === 'prod';
export const isTest = env.NODE_ENV === 'test';
export const isLocal = !!env.DYNAMODB_ENDPOINT;
