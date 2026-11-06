/**
 * The money journey (#228): one real bill through the deployed dev API and
 * real Stripe test mode, checking the fee model end to end. Deploy API runs
 * it after every dev deploy and fails the run on any mismatch.
 *
 *   1. A lead and two guests sign in (@test.invalid test accounts).
 *   2. The lead scans a fixture receipt. The same photo is read once and
 *      then comes from the analysis cache, so most runs don't call Bedrock.
 *   3. The lead starts the £1 hold. The app's Checkout form needs a
 *      browser, so this places the hold Checkout would (same customer,
 *      metadata, manual capture, card saved for off-session) with Stripe's
 *      test card, and the API records it through the page's own poll.
 *   4. Share; the guests join and claim a line each; payments open; each
 *      guest sends, the lead marks each received, then settles.
 *   5. Checks: the lead is charged the guests' round-ups (worked out with
 *      packages/core's owed.ts from the session and bill the API returned)
 *      on the saved card, once, and the hold is released; in the API's view
 *      and in Stripe.
 *   6. Deletes the Stripe test customer.
 *
 * Not covered: the under-30p "nothing charged" path (unit and integration
 * tested) and a card the bank wants confirmed (3D Secure).
 *
 * Usage:
 *   npm run journey:dev -w apps/api                      # api.test.paymeback.dev
 *   npx tsx scripts/money-journey.ts https://api.test.paymeback.dev
 *
 * The Stripe key: STRIPE_TEST_KEY, else gdp-dev/stripe-secret-key from
 * Secrets Manager (the dev deploy role may read it). Test-mode keys only;
 * it's never printed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { uuidv7 } from '../src/lib/uuid.js';
import {
  checkoutSessionIdOf,
  expectedCharge,
  isTestKey,
  pickClaims,
  settledProblems,
  type IntentView,
  type JourneyBill,
  type JourneySession,
} from '../src/ops/moneyJourney.js';

const API = (
  process.argv[2] ??
  process.env.API_BASE_URL ??
  'https://api.test.paymeback.dev'
).replace(/\/$/, '');
const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'receipts', 'thebank.jpg');
const SECRET = 'gdp-dev/stripe-secret-key';
const started = Date.now();

class JourneyFailed extends Error {}

const fail = (msg: string, extra?: unknown): never => {
  throw new JourneyFailed(extra === undefined ? msg : `${msg}\n${JSON.stringify(extra, null, 2)}`);
};
const step = (msg: string) =>
  console.log(`✓ ${msg}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stripeKey(): Promise<string> {
  if (process.env.STRIPE_TEST_KEY) return process.env.STRIPE_TEST_KEY;
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-west-2' });
  // The deploy that grants the read may have just landed: give IAM a moment.
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await sm.send(new GetSecretValueCommand({ SecretId: SECRET }));
      if (!out.SecretString) fail(`${SECRET} has no string value`);
      return out.SecretString!.trim();
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'AccessDeniedException' || attempt >= 8) throw err;
      await wait(5000);
    }
  }
}

type User = { label: string; userId: string; token: string };

async function call<T>(
  user: User | null,
  method: string,
  p: string,
  opts: { body?: unknown; idempotent?: boolean; expect?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (user) headers.authorization = `Bearer ${user.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotent) headers['idempotency-key'] = uuidv7();
  const res = await fetch(`${API}${p}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (res.status !== (opts.expect ?? 200)) {
    fail(
      `${method} ${p.replace(/[0-9a-f-]{36}/g, ':id')} as ${user?.label ?? 'nobody'}: ${res.status}`,
      body,
    );
  }
  return body as T;
}

async function signIn(label: string, run: string): Promise<User> {
  const r = await call<{ token: string; user: { userId: string } }>(
    null,
    'POST',
    '/v1/auth/email/test-sign-in',
    { body: { email: `journey-${run}-${label}@test.invalid` } },
  );
  return { label, userId: r.user.userId, token: r.token };
}

const view = (pi: Stripe.PaymentIntent): IntentView => ({
  id: pi.id,
  status: pi.status,
  amount: pi.amount,
  amount_received: pi.amount_received,
  payment_method:
    typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method?.id ?? null),
  metadata: pi.metadata,
});

async function main() {
  console.log(`Money journey against ${API}`);
  const key = await stripeKey();
  if (!isTestKey(key)) fail('The Stripe key is not a test-mode key: refusing to make real charges');
  const stripe = new Stripe(key);
  let customerId: string | undefined;

  try {
    await call(null, 'GET', '/healthz');
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const [lead, g1, g2] = await Promise.all([
      signIn('lead', run),
      signIn('guest1', run),
      signIn('guest2', run),
    ]);
    step('lead and two guests signed in');

    // ── The bill ────────────────────────────────────────────────────────
    const bytes = readFileSync(FIXTURE);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await call<
      { status: 'new'; uploadId: string; url: string } | { status: 'duplicate'; billId: string }
    >(lead, 'POST', '/v1/bills/uploads', {
      body: { sha256, sizeBytes: bytes.length, mimeType: 'image/jpeg' },
    });
    if (upload.status !== 'new') fail('A new lead’s photo came back as a duplicate', upload);
    const put = await fetch((upload as { url: string }).url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) fail(`Photo upload failed: ${put.status}`);
    const parsed = await call<{ billId: string }>(lead, 'POST', '/v1/bills/parse', {
      body: { uploadId: (upload as { uploadId: string }).uploadId },
      idempotent: true,
    });
    const billId = parsed.billId;
    const bill = await call<JourneyBill & { totalPence: number }>(
      lead,
      'GET',
      `/v1/bills/${billId}`,
    );
    step(`bill read: ${bill.items.length} lines, ${gbp(bill.totalPence)}`);

    // ── The hold ────────────────────────────────────────────────────────
    const start = await call<{ client_secret: string; amountPence: number }>(
      lead,
      'POST',
      '/v1/billing/table-fee',
      { body: { billId } },
    );
    const holdPence = start.amountPence;
    const csId =
      checkoutSessionIdOf(start.client_secret) ?? fail('No Checkout Session in the client secret');
    const checkout = await stripe.checkout.sessions.retrieve(csId);
    customerId = typeof checkout.customer === 'string' ? checkout.customer : checkout.customer?.id;
    if (!customerId)
      fail('The hold’s Checkout Session has no customer, so the card can’t be saved');
    if (checkout.metadata?.kind !== 'hold' || checkout.metadata.billId !== billId) {
      fail('The Checkout Session isn’t this bill’s hold', checkout.metadata);
    }
    const hold = await stripe.paymentIntents.create(
      {
        amount: holdPence,
        currency: 'gbp',
        customer: customerId!,
        payment_method: 'pm_card_visa',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        confirm: true,
        description: 'Money journey: the lead’s hold',
        metadata: { billId, userId: lead.userId, kind: 'hold' },
      },
      { idempotencyKey: `journey-hold-${billId}` },
    );
    if (hold.status !== 'requires_capture') fail(`The hold is ${hold.status}, not authorised`);
    await stripe.checkout.sessions.expire(csId).catch(() => undefined);
    const status = await call<{ status: string; amountPence: number }>(
      lead,
      'GET',
      `/v1/billing/table-fee/${billId}?payment_intent=${hold.id}`,
    );
    if (status.status !== 'held')
      fail(`The API sees the fee as ${status.status}, not held`, status);
    const before = await call<{ card?: { brand?: string; last4?: string } }>(
      lead,
      'GET',
      '/v1/billing/me',
    );
    if (before.card?.last4 !== '4242') fail('The card wasn’t saved with the hold', before.card);
    step(
      `${gbp(holdPence)} hold authorised, card saved (${before.card?.brand} ${before.card?.last4})`,
    );

    // ── The table ───────────────────────────────────────────────────────
    const picked =
      pickClaims(bill, holdPence) ?? fail('No two lines on the bill reach the 30p minimum');
    const created = await call<{ sessionId: string }>(lead, 'POST', '/v1/sessions', {
      body: { billId },
      expect: 201,
    });
    const sid = created.sessionId;
    await call(lead, 'POST', `/v1/sessions/${sid}/claims`, {
      body: { claimedItemIds: picked.lead },
    });
    const shared = await call<JourneySession & { joinCode: string }>(
      lead,
      'POST',
      `/v1/sessions/${sid}/share`,
    );
    if (shared.platformFeePence !== holdPence) {
      fail(`Shared on ${shared.platformFeePence ?? 'no'} hold, expected ${holdPence}p`);
    }
    for (const [i, g] of [g1, g2].entries()) {
      const found = await call<{ sessionId: string }>(g, 'POST', '/v1/sessions/by-code', {
        body: { code: shared.joinCode },
      });
      if (found.sessionId !== sid) fail('The join code found another bill');
      await call(g, 'POST', `/v1/sessions/${sid}/join`);
      await call(g, 'POST', `/v1/sessions/${sid}/claims`, {
        body: { claimedItemIds: picked.guests[i] },
      });
    }
    step('shared on the hold; both guests joined and claimed a line');

    await call(lead, 'POST', `/v1/sessions/${sid}/open-payments`);
    for (const g of [g1, g2]) {
      const { payment } = await call<{ payment: { paymentId: string; amountPence?: number } }>(
        g,
        'POST',
        `/v1/sessions/${sid}/payments`,
        { idempotent: true, expect: 201 },
      );
      await call(g, 'POST', `/v1/payments/${payment.paymentId}/mark-paid`);
      await call(lead, 'POST', `/v1/sessions/${sid}/participants/${g.userId}/received`);
    }
    const session = await call<JourneySession>(lead, 'GET', `/v1/sessions/${sid}`);
    const expected = expectedCharge(bill, session, [g1.userId, g2.userId]);
    if (expected.total !== picked.roundUps[0] + picked.roundUps[1]) {
      fail('The session’s claims don’t give the round-ups the guests were picked for', {
        expected,
        picked: picked.roundUps,
      });
    }
    step(
      `guests paid and received; round-ups ${expected.perGuest[g1.userId]}p + ${expected.perGuest[g2.userId]}p = ${expected.total}p`,
    );

    // ── Settle ──────────────────────────────────────────────────────────
    await call(lead, 'POST', `/v1/sessions/${sid}/close`);
    const after = await call<{ fees: Array<{ billId: string } & Record<string, unknown>> }>(
      lead,
      'GET',
      '/v1/billing/me',
    );
    const fee = after.fees.find((f) => f.billId === billId);
    const holdNow = await stripe.paymentIntents.retrieve(hold.id);
    const intents = await stripe.paymentIntents.list({ customer: customerId!, limit: 10 });
    const problems = settledProblems({
      expected: expected.total,
      sessionId: sid,
      fee,
      hold: view(holdNow),
      charges: intents.data.filter((pi) => pi.id !== hold.id).map(view),
    });
    if (problems.length) fail(`Settle went wrong:\n  - ${problems.join('\n  - ')}`);
    const charge = intents.data.find((pi) => pi.metadata.kind === 'roundups')!;
    step(
      `settled: charged ${gbp(charge.amount_received)} on the saved card (${charge.id}); hold ${holdNow.status}`,
    );

    const summary =
      `### Money journey ✅\n\n` +
      `| | |\n|---|---|\n` +
      `| Hold | ${gbp(holdPence)}, released (\`${hold.id}\`) |\n` +
      `| Round-ups | ${expected.perGuest[g1.userId]}p + ${expected.perGuest[g2.userId]}p |\n` +
      `| Charged to the lead | ${gbp(charge.amount_received)} (\`${charge.id}\`) |\n` +
      `| Time | ${((Date.now() - started) / 1000).toFixed(1)}s |\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(`\nMoney journey passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    if (customerId) {
      await stripe.customers.del(customerId).then(
        () => console.log('✓ Stripe test customer deleted'),
        (err: unknown) =>
          console.warn(`! Couldn’t delete the Stripe test customer: ${(err as Error).message}`),
      );
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof JourneyFailed ? err.message : String((err as Error)?.stack ?? err);
  console.error(`\n✗ Money journey failed: ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Money journey::${msg.split('\n')[0]}`);
  process.exit(1);
});
