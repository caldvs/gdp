/**
 * #139: the server, not just the web app, asks for the platform fee at the
 * QR. `/share` needs the bill's paid fee (one fee, one share), an exempt
 * lead, or the lead's free bill for the month. Real routes and real rows in
 * DynamoDB; only Stripe is faked.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type Stripe from 'stripe';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { creditStore, tableFeeStore } from '../../src/storage/tableFeeStore.js';
import { monthOf, nextCreditOn } from '../../src/services/billing/tableFee.js';
import {
  createBillFor,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
} from './helpers.js';

const fakeStripe = (
  retrieve: (id: string) => Promise<unknown> = () => Promise.reject(new Error('no')),
) =>
  ({
    refunds: { create: vi.fn(() => Promise.resolve({ id: 're_test' })) },
    checkout: { sessions: { retrieve: vi.fn(retrieve) } },
  }) as unknown as Stripe;

const buildApp = (
  opts: { stripe?: Stripe | null; credits?: boolean; exemptEmails?: string } = {},
) =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    stripe: opts.stripe === undefined ? fakeStripe() : opts.stripe,
    ...(opts.credits === false ? { creditStore: null } : {}),
    ...(opts.exemptEmails ? { exemptEmails: opts.exemptEmails } : {}),
  });

type App = ReturnType<typeof buildApp>;

const payFee = (billId: string, userId: string, extra: { sessionId?: string } = {}) =>
  tableFeeStore.putIfAbsent({
    billId,
    userId,
    checkoutSessionId: `cs_${billId.replace(/-/g, '')}`,
    paymentIntentId: `pi_${billId}`,
    amountPence: 200,
    paidAt: new Date().toISOString(),
    ...extra,
  });

async function newSession(app: App, lead: string, billId?: string) {
  const id = billId ?? (await createBillFor(app, lead)).billId;
  const res = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(lead) },
    body: JSON.stringify({ billId: id }),
  });
  expect(res.status).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return { sessionId, billId: id };
}

const share = (app: App, sessionId: string, lead: string, body?: unknown) =>
  app.request(`/v1/sessions/${sessionId}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(lead) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('share needs the platform fee (#139)', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('refuses an unpaid share with 402 TABLE_FEE_REQUIRED', async () => {
    const app = buildApp({ credits: false });
    const lead = `c-${uuidv7()}`;
    const { sessionId } = await newSession(app, lead);
    const res = await share(app, sessionId, lead);
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('TABLE_FEE_REQUIRED');
    // Still in setup: nothing was shared.
    const get = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(lead) });
    expect(((await get.json()) as { status: string }).status).toBe('setup');
  });

  it('shares on a paid fee and writes the session onto the fee row', async () => {
    const app = buildApp({ credits: false });
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    await payFee(billId, lead);
    const res = await share(app, sessionId, lead);
    expect(res.status).toBe(200);
    expect((await tableFeeStore.get(billId))?.sessionId).toBe(sessionId);
  });

  it('shares for an exempt lead', async () => {
    const lead = `c-${uuidv7()}`;
    const app = buildApp({ credits: false, exemptEmails: `${lead}@example.com` });
    const { sessionId } = await newSession(app, lead);
    expect((await share(app, sessionId, lead)).status).toBe(200);
  });

  it('shares freely when Stripe is off', async () => {
    const app = buildApp({ stripe: null });
    const lead = `c-${uuidv7()}`;
    const { sessionId } = await newSession(app, lead);
    expect((await share(app, sessionId, lead)).status).toBe(200);
  });

  it('refuses a fee already spent on another session', async () => {
    const app = buildApp({ credits: false });
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    await payFee(billId, lead, { sessionId: uuidv7() });
    const res = await share(app, sessionId, lead);
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('TABLE_FEE_REQUIRED');
  });

  it('refuses a refunded fee', async () => {
    const app = buildApp({ credits: false });
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    await payFee(billId, lead);
    await tableFeeStore.markRefunded(billId, {
      refundId: 're_x',
      refundedAt: new Date().toISOString(),
    });
    expect((await share(app, sessionId, lead)).status).toBe(402);
  });

  it('checks a just-paid Checkout Session with Stripe when the webhook is late', async () => {
    const lead = `c-${uuidv7()}`;
    let billIdForStripe = '';
    const app = buildApp({
      credits: false,
      stripe: fakeStripe((id) =>
        Promise.resolve({
          id,
          payment_status: 'paid',
          payment_intent: 'pi_late',
          amount_total: 200,
          metadata: { billId: billIdForStripe, userId: lead },
        }),
      ),
    });
    const { sessionId, billId } = await newSession(app, lead);
    billIdForStripe = billId;
    const res = await share(app, sessionId, lead, { checkoutSessionId: 'cs_test_late' });
    expect(res.status).toBe(200);
    const fee = await tableFeeStore.get(billId);
    expect(fee?.checkoutSessionId).toBe('cs_test_late');
    expect(fee?.sessionId).toBe(sessionId);
  });

  it('lets a new payment replace a spent fee, keeping the old one on record', async () => {
    const app = buildApp({ credits: false });
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    await payFee(billId, lead, { sessionId: uuidv7() });
    expect(
      await tableFeeStore.putIfAbsent({
        billId,
        userId: lead,
        checkoutSessionId: 'cs_second',
        amountPence: 200,
        paidAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toBe('recorded');
    expect((await share(app, sessionId, lead)).status).toBe(200);
    const history = await creditStore.listForUser(lead);
    expect(history.fees.map((f) => f.checkoutSessionId).sort()).toEqual(
      ['cs_second', `cs_${billId.replace(/-/g, '')}`].sort(),
    );
  });
});

describe('one free bill a month', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  const status = async (app: App, billId: string, lead: string) => {
    const res = await app.request(`/v1/billing/table-fee/${billId}`, { headers: makeAuth(lead) });
    expect(res.status).toBe(200);
    return (await res.json()) as { status: string; creditsLeft?: number; nextCreditOn?: string };
  };

  it('spends the credit on the first share, then asks for the fee', async () => {
    const app = buildApp();
    const lead = `c-${uuidv7()}`;
    const first = await newSession(app, lead);
    const next = nextCreditOn(monthOf(new Date()));

    expect(await status(app, first.billId, lead)).toMatchObject({
      status: 'free',
      creditsLeft: 1,
      nextCreditOn: next,
    });
    expect((await share(app, first.sessionId, lead)).status).toBe(200);
    const credit = await creditStore.get(lead, monthOf(new Date()));
    expect(credit).toMatchObject({ sessionId: first.sessionId, billId: first.billId });

    const second = await newSession(app, lead);
    expect(await status(app, second.billId, lead)).toMatchObject({
      status: 'unpaid',
      creditsLeft: 0,
      nextCreditOn: next,
    });
    const res = await share(app, second.sessionId, lead);
    expect(res.status).toBe(402);

    const me = await app.request('/v1/billing/me', { headers: makeAuth(lead) });
    expect(await me.json()).toMatchObject({
      creditsLeft: 0,
      nextCreditOn: next,
      paidPence: 0,
      credits: [{ sessionId: first.sessionId }],
    });
  });

  it('uses a paid fee before the credit', async () => {
    const app = buildApp();
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    await payFee(billId, lead);
    expect((await share(app, sessionId, lead)).status).toBe(200);
    expect(await creditStore.get(lead, monthOf(new Date()))).toBeNull();
  });

  it('gives the credit back when the bill closes with nobody joined', async () => {
    const app = buildApp();
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await newSession(app, lead);
    expect((await share(app, sessionId, lead)).status).toBe(200);
    const close = await app.request(`/v1/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: makeAuth(lead),
    });
    expect(close.status).toBe(200);
    expect((await creditStore.get(lead, monthOf(new Date())))?.returnedAt).toBeDefined();
    expect((await status(app, billId, lead)).status).toBe('free');

    // Spend it again on another bill.
    const again = await newSession(app, lead);
    expect((await share(app, again.sessionId, lead)).status).toBe(200);
    const credit = await creditStore.get(lead, monthOf(new Date()));
    expect(credit?.sessionId).toBe(again.sessionId);
    expect(credit?.returnedAt).toBeUndefined();
  });

  it('a second share can’t take a credit another session holds', async () => {
    const app = buildApp();
    const lead = `c-${uuidv7()}`;
    const a = await newSession(app, lead);
    const b = await newSession(app, lead);
    const [ra, rb] = await Promise.all([
      share(app, a.sessionId, lead),
      share(app, b.sessionId, lead),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 402]);
  });
});
