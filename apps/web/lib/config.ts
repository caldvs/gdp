// NEXT_PUBLIC_* values are inlined at build time — restart `npm run dev`
// after changing them.

/** API origin. Falls back to the deployed dev API (eu-west-2). */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'https://8yh705358k.execute-api.eu-west-2.amazonaws.com';

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
 * local backend running with AUTH_BYPASS_LOCAL=true.
 */
export const DEV_SIGNIN_ENABLED =
  /^http:\/\/(localhost|127\.0\.0\.1)/.test(API_BASE_URL) ||
  /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(API_BASE_URL) ||
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.test(API_BASE_URL) ||
  /^https:\/\/[a-z0-9-]+\.ngrok(-free)?\.app/i.test(API_BASE_URL) ||
  process.env.NEXT_PUBLIC_DEV_SIGNIN === '1';

/** Set in sessionStorage on sign-out so local dev doesn't auto sign straight back in. */
export const DEV_SIGNED_OUT_KEY = 'gdp.dev.signedOut';

/** Stripe publishable key for the table-fee form. Null hides the form. */
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
