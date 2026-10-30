/**
 * Build-time checks for the web app's environment, run from
 * apps/web/next.config.ts so a wrongly configured build fails instead of
 * shipping a site that talks to the wrong API or takes the wrong money.
 *
 * NEXT_PUBLIC_APP_ENV names the environment:
 * - `local`: your machine and CI. The default off Vercel.
 * - `dev`: Vercel Preview (and Production until prod exists).
 * - `prod`: Vercel Production once the prod API is live.
 */

export type WebAppEnv = 'local' | 'dev' | 'prod';

type Env = Record<string, string | undefined>;

const APP_ENVS: readonly WebAppEnv[] = ['local', 'dev', 'prod'];

/** The environment this build is for, or null if it isn't set validly. */
export function webAppEnv(env: Env): WebAppEnv | null {
  const raw = env.NEXT_PUBLIC_APP_ENV?.trim();
  if (!raw) return env.VERCEL ? null : 'local';
  return (APP_ENVS as readonly string[]).includes(raw) ? (raw as WebAppEnv) : null;
}

/** Everything wrong with this build's environment. Empty means it's fine. */
export function buildEnvProblems(env: Env): string[] {
  const problems: string[] = [];
  const appEnv = webAppEnv(env);
  if (!appEnv) {
    problems.push(
      env.NEXT_PUBLIC_APP_ENV
        ? `NEXT_PUBLIC_APP_ENV must be local, dev or prod (got "${env.NEXT_PUBLIC_APP_ENV}")`
        : 'NEXT_PUBLIC_APP_ENV must be set on Vercel (dev or prod)',
    );
    return problems;
  }

  const api = env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (appEnv !== 'local') {
    if (!api) problems.push(`NEXT_PUBLIC_API_BASE_URL must be set when NEXT_PUBLIC_APP_ENV=${appEnv}`);
    else if (!api.startsWith('https://')) problems.push('NEXT_PUBLIC_API_BASE_URL must be https://');
  }

  const pk = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  if (pk) {
    if (pk.startsWith('sk_') || pk.startsWith('rk_')) {
      problems.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a secret key; it must be a pk_ key');
    } else if (appEnv === 'prod' && !pk.startsWith('pk_live_')) {
      problems.push('prod must use a live-mode Stripe publishable key (pk_live_)');
    } else if (appEnv !== 'prod' && !pk.startsWith('pk_test_')) {
      problems.push(`${appEnv} must use a test-mode Stripe publishable key (pk_test_)`);
    }
  }

  return problems;
}
