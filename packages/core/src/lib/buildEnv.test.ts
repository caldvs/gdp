import { describe, expect, it } from 'vitest';
import { buildEnvProblems, webAppEnv } from './buildEnv';

const API = 'https://abc.execute-api.eu-west-2.amazonaws.com';

describe('webAppEnv', () => {
  it('defaults to local off Vercel', () => {
    expect(webAppEnv({})).toBe('local');
  });

  it('has no default on Vercel', () => {
    expect(webAppEnv({ VERCEL: '1' })).toBeNull();
    expect(webAppEnv({ VERCEL: '1', NEXT_PUBLIC_APP_ENV: 'dev' })).toBe('dev');
  });

  it('rejects unknown values', () => {
    expect(webAppEnv({ NEXT_PUBLIC_APP_ENV: 'staging' })).toBeNull();
  });
});

describe('buildEnvProblems', () => {
  it('accepts a local build with nothing set', () => {
    expect(buildEnvProblems({})).toEqual([]);
  });

  it('needs NEXT_PUBLIC_APP_ENV on Vercel', () => {
    expect(buildEnvProblems({ VERCEL: '1', NEXT_PUBLIC_API_BASE_URL: API })).toEqual([
      'NEXT_PUBLIC_APP_ENV must be set on Vercel (dev or prod)',
    ]);
  });

  it('needs an https API URL outside local', () => {
    expect(buildEnvProblems({ NEXT_PUBLIC_APP_ENV: 'dev' })).toEqual([
      'NEXT_PUBLIC_API_BASE_URL must be set when NEXT_PUBLIC_APP_ENV=dev',
    ]);
    expect(
      buildEnvProblems({ NEXT_PUBLIC_APP_ENV: 'prod', NEXT_PUBLIC_API_BASE_URL: 'http://x.example' }),
    ).toEqual(['NEXT_PUBLIC_API_BASE_URL must be https://']);
    expect(buildEnvProblems({ NEXT_PUBLIC_APP_ENV: 'dev', NEXT_PUBLIC_API_BASE_URL: API })).toEqual([]);
  });

  it('matches the Stripe publishable key mode to the environment', () => {
    const dev = { NEXT_PUBLIC_APP_ENV: 'dev', NEXT_PUBLIC_API_BASE_URL: API };
    const prod = { NEXT_PUBLIC_APP_ENV: 'prod', NEXT_PUBLIC_API_BASE_URL: API };
    expect(buildEnvProblems({ ...dev, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_1' })).toEqual([]);
    expect(buildEnvProblems({ ...prod, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_1' })).toEqual([]);
    expect(buildEnvProblems({ ...dev, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_1' })).toEqual([
      'dev must use a test-mode Stripe publishable key (pk_test_)',
    ]);
    expect(buildEnvProblems({ ...prod, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_1' })).toEqual([
      'prod must use a live-mode Stripe publishable key (pk_live_)',
    ]);
  });

  it('refuses a secret key in a public variable', () => {
    expect(buildEnvProblems({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'sk_test_1' })).toEqual([
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a secret key; it must be a pk_ key',
    ]);
  });
});
