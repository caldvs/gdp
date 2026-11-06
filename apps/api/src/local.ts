import { ConsoleSmsSender } from './services/messaging/sms.js';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { localStubVerifier } from './services/authStub.js';
import { createSessionTokenVerifier, type IdTokenVerifier } from './services/auth.js';

// Local development server. Never used by the Lambda (src/lambda.ts).

const port = Number(process.env.PORT ?? 3000);
// Refuse anything that looks like a deployed environment.
const isProduction =
  process.env.NODE_ENV === 'production' || (process.env.APP_ENV ?? 'local') !== 'local';
const hasLocalDb = !!process.env.DYNAMODB_ENDPOINT;

const bypass = process.env.AUTH_BYPASS_LOCAL === 'true';
// Sign in with just an email (no code) — on by default for the local
// stack, off with AUTH_DEV_EMAIL_SIGNIN=false.
const devEmailSignIn = process.env.AUTH_DEV_EMAIL_SIGNIN !== 'false' && hasLocalDb && !isProduction;

if (bypass) {
  if (isProduction) {
    console.error(
      'REFUSING TO START: AUTH_BYPASS_LOCAL=true needs APP_ENV=local and NODE_ENV other than production.',
    );
    process.exit(1);
  }
  if (!hasLocalDb) {
    console.error(
      'REFUSING TO START: AUTH_BYPASS_LOCAL=true requires DYNAMODB_ENDPOINT (must be a local stack).',
    );
    process.exit(1);
  }
  console.warn('⚠ AUTH_BYPASS_LOCAL=true — accepting `dev:<userId>` tokens from any caller.');
  console.warn(
    '⚠ Local-only. Refuses to start without a local DDB endpoint, or outside APP_ENV=local.',
  );
}

// Session JWTs need a secret. Locally, fall back to a fixed dev-only one
// so sign-ins survive restarts without any setup.
const jwtSecretText =
  process.env.SESSION_JWT_SECRET ??
  (hasLocalDb && !isProduction ? 'local-dev-only-session-secret-not-for-prod' : undefined);
const sessionJwtSecret = jwtSecretText ? new TextEncoder().encode(jwtSecretText) : undefined;
const sessionVerifier = sessionJwtSecret ? createSessionTokenVerifier(sessionJwtSecret) : undefined;

// With the bypass on, accept both `dev:<userId>` shortcut tokens and real
// session tokens (from email sign-in).
const idTokenVerifier: IdTokenVerifier | undefined =
  bypass && sessionVerifier
    ? (token) => (token.startsWith('dev:') ? localStubVerifier(token) : sessionVerifier(token))
    : bypass
      ? localStubVerifier
      : sessionVerifier;

if (devEmailSignIn) {
  console.warn(
    '⚠ Dev email sign-in on — POST /v1/auth/email/dev-sign-in signs in any email without a code.',
  );
}

const app = createApp({
  ...(idTokenVerifier ? { idTokenVerifier } : {}),
  ...(sessionJwtSecret ? { sessionJwtSecret } : {}),
  devEmailSignIn,
  // #213, #231: phone codes printed here instead of texted, unless a real
  // sender ID is set.
  phoneSms: process.env.SMS_SENDER_ID ? undefined : new ConsoleSmsSender({ printCodes: true }),
  // Test accounts (@test.invalid, no code), same as on dev.
  testAccountSignIn: hasLocalDb && !isProduction,
});

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `gdp-backend listening on http://localhost:${info.port}${bypass ? ' (auth-bypass)' : ''}${devEmailSignIn ? ' (dev email sign-in)' : ''}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    process.env.STRIPE_SECRET_KEY
      ? `stripe: table fee on${process.env.STRIPE_WEBHOOK_SECRET ? '' : ' (no STRIPE_WEBHOOK_SECRET: /webhooks/stripe off)'}`
      : 'stripe: table fee off (no STRIPE_SECRET_KEY in apps/api/.env.local)',
  );
});
