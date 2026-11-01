import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import Stripe from 'stripe';
import { env } from '../config/env.js';
import type { FeeLookupKey } from '../services/billing/tableFee.js';

/**
 * Checks that the deployed Lambda can actually use what it depends on:
 * Stripe keys and prices, Bedrock model access, the Gemini key, the Places
 * key and the SES sender. These are the settings unit tests can't see, and
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
const GEMINI_MODEL = 'gemini-2.5-flash';

const snippet = async (res: Response): Promise<string> =>
  (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);

const stripeCheck: Check = {
  name: 'Stripe',
  required: true,
  run: async () => {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) throw skip('Stripe not enabled (no STRIPE_SECRET_KEY)');
    if (!/^(sk|rk)_(test|live)_/.test(key)) {
      throw new Error(
        'STRIPE_SECRET_KEY is not an sk_/rk_ key (wrapped in JSON, or the wrong value?)',
      );
    }
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

const geminiCheck: Check = {
  name: 'Gemini (fallback reader)',
  required: false,
  run: async () => {
    if (!env.GEMINI_API_KEY) throw skip('GEMINI_API_KEY not set');
    // Looks the model up rather than generating, so it checks the key
    // without spending the free tier's daily request quota.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`,
      {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await snippet(res)}`);
    return `key valid for ${GEMINI_MODEL} (daily quota not checked)`;
  },
};

const placesCheck: Check = {
  name: 'Google Places (venue lookup)',
  required: false,
  run: async () => {
    if (!env.GOOGLE_PLACES_API_KEY) throw skip('GOOGLE_PLACES_API_KEY not set');
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GOOGLE_PLACES_API_KEY,
        'x-goog-fieldmask': 'places.id',
      },
      body: JSON.stringify({ textQuery: 'Manchester Piccadilly station', maxResultCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await snippet(res)}`);
    return 'search returned 200';
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

export const CHECKS: readonly Check[] = [
  stripeCheck,
  bedrockCheck,
  geminiCheck,
  placesCheck,
  sesCheck,
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
