import type { NextConfig } from 'next';
import { buildEnvProblems } from '../../packages/core/src/lib/buildEnv';

// Fail the build rather than ship one that talks to the wrong API or takes
// the wrong kind of Stripe money. See packages/core/src/lib/buildEnv.ts.
const envProblems = buildEnvProblems(process.env);
if (envProblems.length) {
  throw new Error(`Web build environment is wrong:\n- ${envProblems.join('\n- ')}`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @gdp/core ships TypeScript source; let Next compile it.
  transpilePackages: ['@gdp/core'],
  // Vercel's environment (production | preview | development), for the
  // client. The test bar is never shown on Production (lib/config.ts).
  env: { NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV || '' },
};

export default nextConfig;
