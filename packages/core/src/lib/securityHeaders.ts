/**
 * The web app's security headers (#150), set for every route in
 * apps/web/next.config.ts. Built from the build's environment so the CSP
 * lets the page reach its own API and nothing else.
 *
 * What the page loads from elsewhere:
 * - its API (NEXT_PUBLIC_API_BASE_URL, the custom domains, or API Gateway's
 *   execute-api URL), and S3 for bill photo uploads (presigned PUT) and
 *   photos shown back (presigned GET); locally the API on :3000 and MinIO on :9000
 * - Stripe.js and the embedded checkout form (js.stripe.com, frames and
 *   calls to *.stripe.com)
 * - Vercel Web Analytics (same-origin /_vercel/insights; the debug script
 *   from va.vercel-scripts.com off Vercel); the Vercel toolbar on Preview
 * - camera frames, photo previews and the HEIC converter's worker as blob:
 *
 * Scripts allow 'unsafe-inline': Next's inline bootstrap scripts need it,
 * and nonces would force every page to render per request (see Next's CSP
 * guide). 'unsafe-eval' is there for heic2any, whose libheif build makes
 * functions with `new Function` inside its blob: worker.
 */

type Env = Record<string, string | undefined>;

const AWS_REGION = 'eu-west-2';

const API_ORIGINS = [
  'https://api.paymeback.dev',
  'https://api.test.paymeback.dev',
  `https://*.execute-api.${AWS_REGION}.amazonaws.com`,
];

const S3_ORIGINS = [`https://*.s3.${AWS_REGION}.amazonaws.com`, 'https://*.s3.amazonaws.com'];
const LOCAL_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:9000', 'http://127.0.0.1:9000'];

const STRIPE_SCRIPT = ['https://js.stripe.com', 'https://*.js.stripe.com'];
const STRIPE_ANY = ['https://*.stripe.com'];

const VERCEL_SCRIPT = ['https://va.vercel-scripts.com'];
// The Preview toolbar (comments, share): vercel.com/docs/vercel-toolbar.
const VERCEL_LIVE = ['https://vercel.live'];
const VERCEL_LIVE_CONNECT = ['https://vercel.live', 'wss://ws-us3.pusher.com'];
const VERCEL_LIVE_IMG = ['https://vercel.live', 'https://vercel.com'];

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

function directive(name: string, values: (string | null | false | undefined)[]): string {
  const uniq = [...new Set(values.filter((v): v is string => !!v))];
  return uniq.length ? `${name} ${uniq.join(' ')}` : name;
}

export function contentSecurityPolicy(env: Env): string {
  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim() || 'local';
  const local = appEnv === 'local';
  const devServer = env.NODE_ENV === 'development';
  const preview = env.VERCEL_ENV === 'preview';
  const api = originOf(env.NEXT_PUBLIC_API_BASE_URL);
  const live = preview ? VERCEL_LIVE : [];

  return [
    directive('default-src', ["'self'"]),
    directive('script-src', [
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      ...STRIPE_SCRIPT,
      ...VERCEL_SCRIPT,
      ...live,
    ]),
    directive('style-src', ["'self'", "'unsafe-inline'"]),
    directive('img-src', [
      "'self'",
      'data:',
      'blob:',
      ...S3_ORIGINS,
      ...STRIPE_ANY,
      ...(local ? LOCAL_ORIGINS : []),
      ...(preview ? VERCEL_LIVE_IMG : []),
    ]),
    directive('font-src', ["'self'", 'data:', ...live]),
    directive('connect-src', [
      "'self'",
      api,
      ...API_ORIGINS,
      ...S3_ORIGINS,
      ...STRIPE_ANY,
      ...VERCEL_SCRIPT,
      ...(local ? LOCAL_ORIGINS : []),
      ...(devServer ? ['ws:'] : []),
      ...(preview ? VERCEL_LIVE_CONNECT : []),
    ]),
    directive('frame-src', [...STRIPE_SCRIPT, ...STRIPE_ANY, ...live]),
    directive('worker-src', ["'self'", 'blob:']),
    directive('media-src', ["'self'", 'blob:']),
    directive('object-src', ["'none'"]),
    directive('base-uri', ["'self'"]),
    directive('form-action', ["'self'"]),
    directive('frame-ancestors', ["'none'"]),
    ...(local ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function securityHeaders(env: Env): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
  ];
}
