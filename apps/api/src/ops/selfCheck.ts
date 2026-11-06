import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GeoPlacesClient, SearchTextCommand } from '@aws-sdk/client-geo-places';
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

/** A £1 sandbox hold on Stripe's `pm_card_visa` test card. */
async function placeSmokeHold(stripe: Stripe, smokeId: string): Promise<Stripe.PaymentIntent> {
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
  return hold;
}

/** The real fee service over an in-memory row for one smoke-test hold. */
function smokeService(
  stripe: Stripe,
  smokeId: string,
  hold: Stripe.PaymentIntent,
  saved: { customerId?: string; paymentMethodId?: string } = {},
) {
  const rows = new Map<string, TableFee>();
  rows.set(smokeId, {
    billId: smokeId,
    userId: smokeId,
    checkoutSessionId: `cs_${smokeId}`,
    paymentIntentId: hold.id,
    kind: 'hold',
    amountPence: HOLD_PENCE,
    paidAt: new Date().toISOString(),
    sessionId: smokeId,
    ...saved,
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
    markCaptured: (billId, capture) => {
      const fee = rows.get(billId);
      if (!fee || fee.capturedAt || fee.releasedAt) return Promise.resolve('duplicate');
      rows.set(billId, { ...fee, ...capture });
      return Promise.resolve('recorded');
    },
    markCharge: (billId, charge) => {
      const existing = rows.get(billId);
      const ok =
        !!existing &&
        (!existing.chargeStatus ||
          (charge.chargeStatus === 'charged' && existing.chargeStatus === 'needs_confirming'));
      if (!ok) return Promise.resolve('duplicate');
      rows.set(billId, { ...existing, ...charge });
      return Promise.resolve('recorded');
    },
    setChargeIntent: (billId, chargeIntentId) => {
      const existing = rows.get(billId);
      if (existing) rows.set(billId, { ...existing, chargeIntentId });
      return Promise.resolve();
    },
    markRefunded: () => Promise.resolve('duplicate'),
  };
  const fees = createTableFeeService({
    stripe,
    store,
    getBill: () => Promise.resolve(null),
    appBaseUrl: env.APP_BASE_URL,
  });
  return { rows, fees };
}

/**
 * Smoke test for the hold, against real Stripe, through the same code the
 * close and bin routes use: a £1 sandbox hold released as on a bill nobody
 * joined, and another with 66p taken as the guests' part at close (#167).
 * Proves the key can place, cancel and part-capture holds. The fee rows
 * are kept in memory, so the table isn't touched. Test mode only.
 */
export async function holdRoundTrip(stripe: Stripe): Promise<string> {
  const smokeId = `smoke-${Date.now()}`;
  const hold = await placeSmokeHold(stripe, smokeId);
  const { rows, fees } = smokeService(stripe, smokeId, hold);
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

  // A table people joined: the guests' 66p is taken, the rest released.
  const takeId = `${smokeId}-take`;
  const second = await placeSmokeHold(stripe, takeId);
  const take = smokeService(stripe, takeId, second);
  const taken = await take.fees.takeFromHold(
    {
      ...session,
      sessionId: takeId,
      billId: takeId,
      participants: [{ userId: takeId }, { userId: 'guest' }],
    },
    66,
  );
  if (taken !== 'captured') throw new Error(`capture outcome was ${taken}, not captured`);
  const captured = await stripe.paymentIntents.retrieve(second.id);
  if (captured.status !== 'succeeded' || captured.amount_received !== 66) {
    throw new Error(
      `hold ${second.id} is ${captured.status} with ${captured.amount_received}p, not 66p taken`,
    );
  }
  return `held ${hold.id} £1.00, released; held ${second.id} £1.00, took £0.66`;
}

/**
 * #228 smoke test, against real Stripe through the same code settle uses: a
 * £1 hold that saves `pm_card_visa` to a fresh customer, then at settle the
 * hold released and the saved card charged £1.84 off-session; then a card
 * whose bank always asks to confirm (`pm_card_authenticationRequired`) is
 * left needing the lead. Test mode only; fee rows stay in memory.
 */
export async function savedCardRoundTrip(stripe: Stripe): Promise<string> {
  const smokeId = `smoke-${Date.now()}-card`;
  const customer = await stripe.customers.create({
    description: 'Deploy smoke test: saved card',
    metadata: { smoke: 'saved-card' },
  });
  try {
    const hold = await stripe.paymentIntents.create({
      amount: HOLD_PENCE,
      currency: 'gbp',
      capture_method: 'manual',
      customer: customer.id,
      payment_method: 'pm_card_visa',
      setup_future_usage: 'off_session',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      confirm: true,
      description: 'Deploy smoke test: platform fee hold that saves the card',
      metadata: { billId: smokeId, smoke: 'saved-card' },
    });
    if (hold.status !== 'requires_capture') {
      throw new Error(`hold ${hold.id} is ${hold.status}, not requires_capture`);
    }
    const pm =
      typeof hold.payment_method === 'string' ? hold.payment_method : hold.payment_method?.id;
    if (!pm) throw new Error(`hold ${hold.id} has no saved payment method`);
    const { rows, fees } = smokeService(stripe, smokeId, hold, {
      customerId: customer.id,
      paymentMethodId: pm,
    });
    const table = {
      sessionId: smokeId,
      billId: smokeId,
      creatorUserId: smokeId,
      participants: [{ userId: smokeId }, { userId: 'guest' }],
    };
    const charged = await fees.takeFromHold(table, 184);
    if (charged !== 'charged') throw new Error(`settle outcome was ${charged}, not charged`);
    const row = rows.get(smokeId);
    const after = await stripe.paymentIntents.retrieve(hold.id);
    if (after.status !== 'canceled')
      throw new Error(`hold ${hold.id} is ${after.status}, not canceled`);
    const charge = await stripe.paymentIntents.retrieve(row?.chargeIntentId ?? '');
    if (charge.status !== 'succeeded' || charge.amount_received !== 184) {
      throw new Error(`charge ${charge.id} is ${charge.status} with ${charge.amount_received}p`);
    }

    // A bank that wants the lead to confirm: needs confirming, not an error.
    const asks = await stripe.paymentMethods.attach('pm_card_authenticationRequired', {
      customer: customer.id,
    });
    const askId = `${smokeId}-3ds`;
    const second = await stripe.paymentIntents.create({
      amount: HOLD_PENCE,
      currency: 'gbp',
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      confirm: true,
      description: 'Deploy smoke test: platform fee hold',
      metadata: { billId: askId, smoke: 'saved-card' },
    });
    const ask = smokeService(stripe, askId, second, {
      customerId: customer.id,
      paymentMethodId: asks.id,
    });
    const outcome = await ask.fees.takeFromHold({ ...table, sessionId: askId, billId: askId }, 184);
    if (outcome !== 'needs_confirming') {
      throw new Error(`3D Secure card outcome was ${outcome}, not needs_confirming`);
    }
    return `saved card on ${customer.id}: hold released, charged £1.84 (${charge.id}); 3D Secure card needs confirming`;
  } finally {
    await stripe.customers.del(customer.id).catch(() => undefined);
  }
}

const savedCardCheck: Check = {
  name: 'Stripe saved card (settle charge)',
  required: true,
  run: async () => {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) throw skip('Stripe not enabled (no STRIPE_SECRET_KEY)');
    if (!key.includes('_test_')) throw skip('live key: charges are only smoke-tested in test mode');
    return savedCardRoundTrip(new Stripe(key, { timeout: TIMEOUT_MS, maxNetworkRetries: 0 }));
  },
};

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

export const CHECKS: readonly Check[] = [
  stripeCheck,
  holdCheck,
  savedCardCheck,
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
