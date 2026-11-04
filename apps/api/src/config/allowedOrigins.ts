/**
 * Which browser origins may call the API (CORS) and upload to the bills
 * bucket. Each pattern is an exact origin, or one with a single `*` that
 * stands for one or more letters or digits (no hyphens, so it can't stretch
 * into another account's hostname), placed where S3's bucket CORS accepts it:
 *
 *   https://paymeback.dev
 *   https://web-nqib-*-caldvs-projects.vercel.app
 *
 * The same lists feed the Lambda (ALLOWED_ORIGINS) and the bucket rule in
 * infra/main.ts, so the two can't drift.
 */
export type EnvName = 'dev' | 'prod';

// This project's Vercel preview deployments only (`web-nqib-<hash>-…`, #149).
const PREVIEWS = 'https://web-nqib-*-caldvs-projects.vercel.app';

export const ALLOWED_ORIGINS: Record<EnvName, string[]> = {
  dev: ['https://test.paymeback.dev', PREVIEWS, 'http://localhost:8081'],
  prod: ['https://paymeback.dev', 'https://web-nqib.vercel.app'],
};

/**
 * Where a sign-in link may point, besides APP_BASE_URL (#149). Exact bases
 * only: the request's Origin is used as the link's base only when it is
 * one of these, character for character. Prod has none, so its links
 * always go to APP_BASE_URL. Previews aren't listed (their hostnames
 * change), so someone signing in on one gets a link to APP_BASE_URL.
 */
export const SIGN_IN_LINK_BASES: Record<EnvName | 'local', string[]> = {
  dev: ['https://test.paymeback.dev', 'http://localhost:8081'],
  prod: [],
  local: [],
};

/** The sign-in link's base: the Origin if it's exactly a listed base, else the fallback. */
export function pickLinkBase(
  origin: string | undefined,
  bases: readonly string[],
  fallback: string,
): string {
  return origin && bases.includes(origin) ? origin : fallback;
}

export function parseOrigins(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A predicate for the request's Origin header. An empty list allows any origin (local dev). */
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  if (patterns.length === 0) return () => true;
  const res = patterns.map((p) => {
    const parts = p.split('*');
    if (parts.length > 2) throw new Error(`origin pattern has more than one *: ${p}`);
    const esc = parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${esc.join('[a-z0-9]+')}$`, 'i');
  });
  return (origin) => res.some((re) => re.test(origin));
}
