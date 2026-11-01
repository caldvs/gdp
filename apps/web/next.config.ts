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
};

export default nextConfig;
