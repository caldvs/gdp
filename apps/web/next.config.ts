import type { NextConfig } from 'next';
import { buildEnvProblems } from '../../packages/core/src/lib/buildEnv';
import { securityHeaders } from '../../packages/core/src/lib/securityHeaders';

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
  // CSP, no framing, no referrer (#150). packages/core/src/lib/securityHeaders.ts.
  // Sign-in links (before 6-digit codes) land on the sign-in screen.
  // Storybook (test and local builds, scripts/build-storybook.mjs) lives in
  // public/storybook; its pages use relative URLs, so it opens at index.html.
  async redirects() {
    return [
      { source: '/sign-in/verify', destination: '/sign-in/email', permanent: false },
      { source: '/storybook', destination: '/storybook/index.html', permanent: false },
    ];
  },
  // Storybook shows stories in a same-origin iframe; everything else is never framed.
  async headers() {
    return [
      { source: '/:path((?!storybook/).*)', headers: securityHeaders(process.env) },
      { source: '/storybook/:path*', headers: securityHeaders(process.env, { sameOriginFrames: true }) },
    ];
  },
};

export default nextConfig;
