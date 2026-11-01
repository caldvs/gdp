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
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'from-env' };
    const fetch = fetcher({});
    expect(await loadRuntimeSecrets(env, fetch)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.GEMINI_API_KEY).toBe('from-env');
  });

  it('puts each secret into its setting, fetching each name once', async () => {
    const env: NodeJS.ProcessEnv = {
      SECRET_SOURCES: JSON.stringify({
        GEMINI_API_KEY: 'gdp-dev/gemini-api-key',
        STRIPE_SECRET_KEY: 'gdp-dev/stripe-secret-key',
        ALSO_GEMINI: 'gdp-dev/gemini-api-key',
      }),
    };
    const fetch = fetcher({ 'gdp-dev/gemini-api-key': 'g', 'gdp-dev/stripe-secret-key': 's' });
    const loaded = await loadRuntimeSecrets(env, fetch);
    expect(loaded).toEqual(['GEMINI_API_KEY', 'STRIPE_SECRET_KEY', 'ALSO_GEMINI']);
    expect(fetch).toHaveBeenCalledWith(['gdp-dev/gemini-api-key', 'gdp-dev/stripe-secret-key']);
    expect(env).toMatchObject({ GEMINI_API_KEY: 'g', STRIPE_SECRET_KEY: 's', ALSO_GEMINI: 'g' });
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
