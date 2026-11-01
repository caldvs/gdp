import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Deployed Lambdas get secret *names*, not values: SECRET_SOURCES is JSON
 * mapping each setting to its Secrets Manager secret, e.g.
 * `{"GEMINI_API_KEY":"gdp-dev/gemini-api-key"}` (set by infra/main.ts).
 * At cold start the values are fetched once and put into the environment,
 * before env.ts reads it. So nothing secret sits in the function's
 * configuration, and a rotated secret is picked up by the next cold start.
 *
 * Don't import env.ts from here: it validates process.env at import time,
 * and this has to run first.
 */

/** Fetches secret values by name. Rejects if any of them can't be read. */
export type SecretFetcher = (names: string[]) => Promise<Map<string, string>>;

export async function loadRuntimeSecrets(
  target: NodeJS.ProcessEnv,
  fetchSecrets: SecretFetcher = fetchFromSecretsManager,
): Promise<string[]> {
  const raw = target.SECRET_SOURCES?.trim();
  if (!raw) return [];

  let sources: Record<string, string>;
  try {
    sources = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error('SECRET_SOURCES is not valid JSON');
  }
  const entries = Object.entries(sources);
  if (entries.some(([k, v]) => !k || typeof v !== 'string' || !v)) {
    throw new Error('SECRET_SOURCES must map setting names to secret names');
  }

  const values = await fetchSecrets([...new Set(entries.map(([, name]) => name))]);
  for (const [setting, name] of entries) {
    const value = values.get(name);
    if (value === undefined) throw new Error(`secret ${name} (for ${setting}) has no value`);
    target[setting] = value;
  }
  return entries.map(([setting]) => setting);
}

const fetchFromSecretsManager: SecretFetcher = async (names) => {
  const client = new SecretsManagerClient({});
  const pairs = await Promise.all(
    names.map(async (name) => {
      try {
        const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
        if (typeof out.SecretString !== 'string') throw new Error('not a string secret');
        return [name, out.SecretString] as const;
      } catch (err) {
        throw new Error(`couldn't read secret ${name}: ${(err as Error).message}`, { cause: err });
      }
    }),
  );
  return new Map(pairs);
};
