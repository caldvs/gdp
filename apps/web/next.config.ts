import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @gdp/core ships TypeScript source; let Next compile it.
  transpilePackages: ['@gdp/core'],
};

export default nextConfig;
