// NEXT_PUBLIC_* values are inlined at build time — restart `npm run dev`
// after changing them.

/**
 * API origin as configured. Deployed builds must set it: next.config.ts
 * fails the build otherwise (packages/core/src/lib/buildEnv.ts).
 */
const CONFIGURED_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

/** API origin. Unset only in local and CI builds, where it's the local API. */
export const API_BASE_URL = CONFIGURED_API_BASE_URL || 'http://localhost:3000';

/**
 * Public-facing URL of this web app, used in QR codes and share links so
 * they open from another phone. Falls back to window.location.origin,
 * which works as long as the lead loaded the app from a reachable URL.
 */
export const PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || null;

export function publicBaseUrl(): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * Dev sign-in shortcuts (dev:<userId> tokens) — only useful against a
 * local backend running with AUTH_BYPASS_LOCAL=true. Judged on the URL as
 * configured, so the localhost default (CI's e2e build) doesn't turn them on.
 */
export const DEV_SIGNIN_ENABLED =
  /^http:\/\/(localhost|127\.0\.0\.1)/.test(CONFIGURED_API_BASE_URL) ||
  /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(CONFIGURED_API_BASE_URL) ||
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.test(CONFIGURED_API_BASE_URL) ||
  /^https:\/\/[a-z0-9-]+\.ngrok(-free)?\.app/i.test(CONFIGURED_API_BASE_URL) ||
  process.env.NEXT_PUBLIC_DEV_SIGNIN === '1';

/** Which environment this build is for (see packages/core/src/lib/buildEnv.ts). */
export const WEB_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV || 'local';

/**
 * The test bar (sign in as test accounts, one tab at a time). On for dev
 * builds, and locally when talking to a local API. Never in prod, and off
 * in CI's e2e build (local, no API URL configured). NEXT_PUBLIC_TEST_TOOLS=0
 * turns it off.
 */
export const TEST_TOOLS_ENABLED =
  process.env.NEXT_PUBLIC_TEST_TOOLS !== '0' &&
  (WEB_APP_ENV === 'dev' || (WEB_APP_ENV === 'local' && DEV_SIGNIN_ENABLED));

/** Set in sessionStorage on sign-out so local dev doesn't auto sign straight back in. */
export const DEV_SIGNED_OUT_KEY = 'gdp.dev.signedOut';

/** Stripe publishable key for the table-fee form. Null hides the form. */
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
