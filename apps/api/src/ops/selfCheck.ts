import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import {
  GeoPlacesClient,
  SearchNearbyCommand,
  SearchTextCommand,
} from '@aws-sdk/client-geo-places';
import { FOOD_AND_DRINK, NEARBY_RADIUS_M } from '../services/venues/nearbyVenues.js';
import Stripe from 'stripe';
import { env } from '../config/env.js';
import {
  createTableFeeService,
  HOLD_PENCE,
  type TableFee,
  type TableFeeStore,
} from '../services/billing/tableFee.js';

/**
 * Checks that the deployed Lambda can actually use what it depends on:
 * Stripe keys, Bedrock model access, the Amazon Location venue
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
    // Proves the key works. The hold's amount is set in code (no Dashboard prices).
    await stripe.paymentIntents.list({ limit: 1 });
    return `${key.includes('_live_') ? 'live' : 'test'} mode`;
  },
};

/**
 * Smoke test for the hold, against real Stripe: a £1 sandbox hold (Stripe's
 * `pm_card_visa` test card), released by the same code that releases the
 * hold on a bill nobody joined. Proves the key can place and cancel holds.
 * The fee row is kept in memory, so the table isn't touched. Test mode only.
 */
export async function holdRoundTrip(stripe: Stripe): Promise<string> {
  const smokeId = `smoke-${Date.now()}`;
  const hold = await stripe.paymentIntents.create({
    amount: HOLD_PENCE,
    currency: 'gbp',
    capture_method: 'manual',
    payment_method: 'pm_card_visa',
    // Card only: nothing that would need a redirect to confirm.
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    confirm: true,
    description: 'Deploy smoke test: platform fee hold',
    metadata: { billId: smokeId, smoke: 'hold' },
  });
  if (hold.status !== 'requires_capture') {
    throw new Error(`test hold ${hold.id} is ${hold.status}, not requires_capture`);
  }

  const rows = new Map<string, TableFee>();
  rows.set(smokeId, {
    billId: smokeId,
    userId: smokeId,
    checkoutSessionId: `cs_${smokeId}`,
    paymentIntentId: hold.id,
    kind: 'hold',
    amountPence: HOLD_PENCE,
    paidAt: new Date().toISOString(),
  });
  const store: TableFeeStore = {
    get: (billId) => Promise.resolve(rows.get(billId) ?? null),
    putIfAbsent: () => Promise.resolve('duplicate'),
    markReleased: (billId, releasedAt) => {
      const fee = rows.get(billId);
      if (!fee || fee.releasedAt) return Promise.resolve('duplicate');
      rows.set(billId, { ...fee, releasedAt });
      return Promise.resolve('recorded');
    },
    markRefunded: () => Promise.resolve('duplicate'),
  };
  const fees = createTableFeeService({
    stripe,
    store,
    getBill: () => Promise.resolve(null),
    appBaseUrl: env.APP_BASE_URL,
  });
  const session = {
    sessionId: smokeId,
    billId: smokeId,
    creatorUserId: smokeId,
    participants: [{ userId: smokeId }],
  };
  const outcome = await fees.refundIfNobodyJoined(session);
  if (outcome !== 'released') throw new Error(`release outcome was ${outcome}, not released`);
  if (!rows.get(smokeId)?.releasedAt) throw new Error('release not recorded on the fee row');

  const after = await stripe.paymentIntents.retrieve(hold.id);
  if (after.status !== 'canceled')
    throw new Error(`hold ${hold.id} is ${after.status}, not canceled`);
  return `held ${hold.id} £1.00, released`;
}

const holdCheck: Check = {
  name: 'Stripe hold (nobody joined)',
  required: true,
  run: async () => {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) throw skip('Stripe not enabled (no STRIPE_SECRET_KEY)');
    if (!key.includes('_test_')) throw skip('live key: holds are only smoke-tested in test mode');
    return holdRoundTrip(new Stripe(key, { timeout: TIMEOUT_MS, maxNetworkRetries: 0 }));
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

const nearbyCheck: Check = {
  name: 'Amazon Location (nearby places)',
  // No nearby places means the scan screen asks for a name, so it only warns.
  required: false,
  run: async () => {
    if (env.VENUE_LOOKUP !== 'amazon-location') throw skip('VENUE_LOOKUP is none');
    const client = new GeoPlacesClient({ region: env.AWS_REGION });
    try {
      // Same call the app makes (food and drink, 300 m), around Piccadilly
      // Gardens. SingleUse: not stored, so billed at the lower rate.
      const out = await client.send(
        new SearchNearbyCommand({
          QueryPosition: [-2.2367, 53.4808],
          QueryRadius: NEARBY_RADIUS_M,
          MaxResults: 1,
          Filter: { IncludeCategories: FOOD_AND_DRINK },
          IntendedUse: 'SingleUse',
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const top = out.ResultItems?.[0];
      if (!top) throw new Error('no food or drink place near Piccadilly Gardens');
      return `found "${top.Title ?? top.PlaceId ?? '?'}" ${top.Distance ?? '?'} m away`;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      throw new Error(`${e.name ?? 'error'}: ${e.message ?? ''}`.slice(0, 300), { cause: err });
    }
  },
};

export const CHECKS: readonly Check[] = [
  stripeCheck,
  holdCheck,
  bedrockCheck,
  venueCheck,
  nearbyCheck,
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
