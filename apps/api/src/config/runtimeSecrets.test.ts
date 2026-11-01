import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeSecrets, type SecretFetcher } from './runtimeSecrets.js';

const fetcher = (values: Record<string, string>): SecretFetcher =>
  vi.fn((names: string[]) => {
    const found = new Map<string, string>();
    for (const n of names) if (n in values) found.set(n, values[n]!);
    return Promise.resolve(found);
  });

describe('loadRuntimeSecrets', () => {
  it('does nothing without SECRET_SOURCES (local and tests)', async () => {
    const env: NodeJS.ProcessEnv = { SESSION_JWT_SECRET: 'from-env' };
    const fetch = fetcher({});
    expect(await loadRuntimeSecrets(env, fetch)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.SESSION_JWT_SECRET).toBe('from-env');
  });

  it('puts each secret into its setting, fetching each name once', async () => {
    const env: NodeJS.ProcessEnv = {
      SECRET_SOURCES: JSON.stringify({
        SESSION_JWT_SECRET: 'gdp-dev/session-jwt-secret',
        STRIPE_SECRET_KEY: 'gdp-dev/stripe-secret-key',
        ALSO_JWT: 'gdp-dev/session-jwt-secret',
      }),
    };
    const fetch = fetcher({ 'gdp-dev/session-jwt-secret': 'g', 'gdp-dev/stripe-secret-key': 's' });
    const loaded = await loadRuntimeSecrets(env, fetch);
    expect(loaded).toEqual(['SESSION_JWT_SECRET', 'STRIPE_SECRET_KEY', 'ALSO_JWT']);
    expect(fetch).toHaveBeenCalledWith(['gdp-dev/session-jwt-secret', 'gdp-dev/stripe-secret-key']);
    expect(env).toMatchObject({ SESSION_JWT_SECRET: 'g', STRIPE_SECRET_KEY: 's', ALSO_JWT: 'g' });
  });

  it('fails fast when a secret has no value', async () => {
    const env: NodeJS.ProcessEnv = {
      SECRET_SOURCES: JSON.stringify({ SESSION_JWT_SECRET: 'gdp-dev/session-jwt-secret' }),
    };
    await expect(loadRuntimeSecrets(env, fetcher({}))).rejects.toThrow(
      'secret gdp-dev/session-jwt-secret (for SESSION_JWT_SECRET) has no value',
    );
  });

  it('rejects malformed SECRET_SOURCES', async () => {
    await expect(loadRuntimeSecrets({ SECRET_SOURCES: '{nope' }, fetcher({}))).rejects.toThrow(
      'not valid JSON',
    );
    await expect(
      loadRuntimeSecrets({ SECRET_SOURCES: JSON.stringify({ A: '' }) }, fetcher({})),
    ).rejects.toThrow('must map setting names');
  });
});
