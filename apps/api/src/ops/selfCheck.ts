import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GeoPlacesClient, SearchTextCommand } from '@aws-sdk/client-geo-places';
import Stripe from 'stripe';
import { env } from '../config/env.js';
import type { FeeLookupKey } from '../services/billing/tableFee.js';

/**
 * Checks that the deployed Lambda can actually use what it depends on:
 * Stripe keys and prices, Bedrock model access, the Amazon Location venue
 * lookup and the SES sender. These are the settings unit tests can't see, and
 * the ones that broke on the first real deploy.
 *
 * Runs inside the Lambda (so with its real env and IAM role) when it is
 * invoked directly with `{ "gdpSelfCheck": true }`. API Gateway never sends
 * that shape, so it isn't reachable from the internet.
 * `scripts/deps-check.ts` invokes it after each deploy.
 *
 * A `fail` on a required dependency fails the deploy; `warn` is reported but
 * doesn't.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export type CheckResult = { name: string; status: CheckStatus; detail: string; ms: number };
export type SelfCheckReport = { ok: boolean; checks: CheckResult[] };

export const isSelfCheckEvent = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  (event as { gdpSelfCheck?: unknown }).gdpSelfCheck === true;

/** Thrown by a check to report `warn` or `skipped` instead of `fail`. */
class Outcome extends Error {
  constructor(
    readonly status: 'warn' | 'skipped',
    message: string,
  ) {
    super(message);
  }
}
const warn = (msg: string) => new Outcome('warn', msg);
const skip = (msg: string) => new Outcome('skipped', msg);

type Check = {
  name: string;
  /** When false, a failure is reported as `warn`. */
  required: boolean;
  /** Resolves with a short detail line; throws to fail. */
  run: () => Promise<string>;
};

const TIMEOUT_MS = 15_000;
const LOOKUP_KEYS: FeeLookupKey[] = ['table_fee_2', 'table_fee_3'];

/**
 * Stripe keys must match the environment: test-mode keys everywhere except
 * prod, and live-mode keys only in prod. Returns the problem, or null.
 */
export function stripeKeyModeProblem(appEnv: 'local' | 'dev' | 'prod', key: string): string | null {
  const m = /^(sk|rk)_(test|live)_/.exec(key);
  if (!m) return 'STRIPE_SECRET_KEY is not an sk_/rk_ key (wrapped in JSON, or the wrong value?)';
  const mode = m[2];
  if (appEnv === 'prod' && mode !== 'live') return 'prod must use a live-mode Stripe key';
  if (appEnv !== 'prod' && mode !== 'test') return `${appEnv} must use a test-mode Stripe key`;
  return null;
}

const stripeCheck: Check = {
  name: 'Stripe',
  required: true,
  run: async () => {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) throw skip('Stripe not enabled (no STRIPE_SECRET_KEY)');
    const modeProblem = stripeKeyModeProblem(env.APP_ENV, key);
    if (modeProblem) throw new Error(modeProblem);
    if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) {
      throw new Error('STRIPE_WEBHOOK_SECRET is missing or is not a whsec_ secret');
    }
    const stripe = new Stripe(key, { timeout: TIMEOUT_MS, maxNetworkRetries: 0 });
    const prices = await stripe.prices.list({ lookup_keys: LOOKUP_KEYS, active: true, limit: 10 });
    const found = new Map(prices.data.map((p) => [p.lookup_key, p]));
    const missing = LOOKUP_KEYS.filter((k) => !found.get(k));
    if (missing.length) {
      throw new Error(
        `no active price with lookup key ${missing.join(', ')} in this Stripe account`,
      );
    }
    const amounts = LOOKUP_KEYS.map((k) => {
      const p = found.get(k)!;
      return `${k} ${p.currency.toUpperCase()} ${((p.unit_amount ?? 0) / 100).toFixed(2)}`;
    });
    return `${key.includes('_live_') ? 'live' : 'test'} mode · ${amounts.join(', ')}`;
  },
};

const bedrockCheck: Check = {
  name: 'Bedrock (bill reader)',
  required: true,
  run: async () => {
    const model = env.BEDROCK_MODEL_ID;
    if (!model) throw skip('BEDROCK_MODEL_ID not set');
    const client = new BedrockRuntimeClient({ region: env.AWS_REGION });
    try {
      const out = await client.send(
        new ConverseCommand({
          modelId: model,
          messages: [{ role: 'user', content: [{ text: 'Reply with the single word OK.' }] }],
          inferenceConfig: { maxTokens: 5, temperature: 0 },
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const text = out.output?.message?.content?.find((c) => 'text' in c)?.text?.trim();
      return `${model} answered "${text ?? ''}"`;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      throw new Error(`${e.name ?? 'error'}: ${e.message ?? ''}`.slice(0, 300), { cause: err });
    }
  },
};

const venueCheck: Check = {
  name: 'Amazon Location (venue lookup)',
  // A failed lookup leaves the venue as read off the bill, so it only warns.
  required: false,
  run: async () => {
    if (env.VENUE_LOOKUP !== 'amazon-location') throw skip('VENUE_LOOKUP is none');
    const client = new GeoPlacesClient({ region: env.AWS_REGION });
    try {
      // SingleUse: this answer isn't stored, so it's billed at the lower rate.
      const out = await client.send(
        new SearchTextCommand({
          QueryText: 'Piccadilly Gardens, Manchester',
          Filter: { IncludeCountries: ['GBR'], BoundingBox: [-8.65, 49.86, 1.77, 60.86] },
          MaxResults: 1,
          IntendedUse: 'SingleUse',
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const top = out.ResultItems?.[0];
      if (!top) throw new Error('no result for a known UK place');
      return `found "${top.Title ?? top.PlaceId ?? '?'}" (${top.PlaceType ?? '?'})`;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      throw new Error(`${e.name ?? 'error'}: ${e.message ?? ''}`.slice(0, 300), { cause: err });
    }
  },
};

const sesCheck: Check = {
  name: 'SES (email)',
  required: true,
  run: async () => {
    const from = env.SES_FROM_EMAIL;
    if (!from) throw warn('SES_FROM_EMAIL not set: emails are only written to the logs');
    const ses = new SESv2Client({ region: env.AWS_REGION });
    const opts = { abortSignal: AbortSignal.timeout(TIMEOUT_MS) };

    // The sender is verified either as the address itself or via its domain.
    const domain = from.split('@')[1] ?? '';
    let verifiedAs: string | undefined;
    for (const identity of [from, domain]) {
      const id = await ses
        .send(new GetEmailIdentityCommand({ EmailIdentity: identity }), opts)
        .catch(() => undefined);
      if (id?.VerifiedForSendingStatus) {
        verifiedAs = identity;
        break;
      }
    }
    if (!verifiedAs) throw new Error(`${from} is not a verified SES identity (nor is ${domain})`);

    const account = await ses.send(new GetAccountCommand({}), opts);
    if (account.SendingEnabled === false) throw new Error('SES sending is paused for this account');
    if (!account.ProductionAccessEnabled) {
      throw warn(
        `sending as ${from}, but SES is in the sandbox: mail only reaches verified addresses`,
      );
    }
    return `sending as ${from} (verified via ${verifiedAs})`;
  },
};

/** Test accounts let anyone sign in without a code, so they must be off in prod. */
export const testAccountsProblem = (
  appEnv: 'local' | 'dev' | 'prod',
  flag: string,
): string | null =>
  appEnv === 'prod' && flag === 'true' ? 'AUTH_TEST_ACCOUNTS=true in prod: turn it off' : null;

const testAccountsCheck: Check = {
  name: 'Test accounts',
  required: true,
  run: () => {
    const problem = testAccountsProblem(env.APP_ENV, env.AUTH_TEST_ACCOUNTS);
    if (problem) return Promise.reject(new Error(problem));
    return Promise.resolve(
      env.AUTH_TEST_ACCOUNTS === 'true' && env.APP_ENV !== 'prod'
        ? 'on (@test.invalid sign-in without a code)'
        : 'off',
    );
  },
};

export const CHECKS: readonly Check[] = [
  stripeCheck,
  bedrockCheck,
  venueCheck,
  sesCheck,
  testAccountsCheck,
];

const runOne = async (check: Check): Promise<CheckResult> => {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  try {
    const detail = await Promise.race([
      check.run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS + 1000),
      ),
    ]);
    return { name: check.name, status: 'ok', detail, ms: ms() };
  } catch (err) {
    if (err instanceof Outcome)
      return { name: check.name, status: err.status, detail: err.message, ms: ms() };
    const detail = err instanceof Error ? err.message : String(err);
    return { name: check.name, status: check.required ? 'fail' : 'warn', detail, ms: ms() };
  }
};

export const runSelfCheck = async (checks: readonly Check[] = CHECKS): Promise<SelfCheckReport> => {
  const results = await Promise.all(checks.map(runOne));
  return { ok: results.every((r) => r.status !== 'fail'), checks: results };
};
