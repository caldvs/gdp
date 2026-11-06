/**
 * The Refunds page promises: "If nobody joins the bill before you close it
 * or bin it, we refund the fee to your card." These run that promise through
 * the real close and abandon routes and the real fee row in DynamoDB, with
 * only Stripe faked.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
import type Stripe from 'stripe';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { tableFeeStore } from '../../src/storage/tableFeeStore.js';
import {
  buildPayingSession,
  createBillFor,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  setPayoutFor,
} from './helpers.js';

const fakeStripe = (refund: () => Promise<unknown> = () => Promise.resolve({ id: 're_test' })) => {
  const create = vi.fn(refund);
  return {
    refundsCreate: create,
    stripe: {
      refunds: { create },
      checkout: { sessions: { retrieve: vi.fn() } },
    } as unknown as Stripe,
  };
};

const buildApp = (stripe: Stripe) =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    stripe,
  });

type App = ReturnType<typeof buildApp>;

const payFee = (billId: string, userId: string) =>
  tableFeeStore.putIfAbsent({
    billId,
    userId,
    checkoutSessionId: `cs_${billId}`,
    paymentIntentId: `pi_${billId}`,
    amountPence: 200,
    paidAt: new Date().toISOString(),
  });

/** A bill the lead has paid for and shared, which nobody has joined. */
async function sharedNobodyJoined(app: App, lead: string) {
  const bill = await createBillFor(app, lead);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(lead) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const { sessionId } = (await create.json()) as { sessionId: string };
  await payFee(bill.billId, lead);
  await setPayoutFor(app, lead);
  const share = await app.request(`/v1/sessions/${sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(lead),
  });
  expect(share.status).toBe(200);
  return { sessionId, billId: bill.billId };
}

const post = (app: App, path: string, userId: string) =>
  app.request(path, { method: 'POST', headers: makeAuth(userId) });

describe('table fee refund: nobody joined', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('refunds the fee when the lead bins a bill nobody joined', async () => {
    const { stripe, refundsCreate } = fakeStripe();
    const app = buildApp(stripe);
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await sharedNobodyJoined(app, lead);

    expect((await post(app, `/v1/sessions/${sessionId}/abandon`, lead)).status).toBe(200);

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: `pi_${billId}` }),
      { idempotencyKey: `table-fee-refund-cs_${billId}` },
    );
    const refunded = await tableFeeStore.get(billId);
    expect(refunded?.refundId).toBe('re_test');
    expect(refunded?.refundedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refunds the fee when the lead closes a bill nobody joined, once', async () => {
    const { stripe, refundsCreate } = fakeStripe();
    const app = buildApp(stripe);
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await sharedNobodyJoined(app, lead);

    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);
    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);

    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect((await tableFeeStore.get(billId))?.refundId).toBe('re_test');
  });

  it('keeps the fee when a guest joined before the bill was closed', async () => {
    const { stripe, refundsCreate } = fakeStripe();
    const app = buildApp(stripe);
    const lead = `c-${uuidv7()}`;
    const { sessionId, bill } = await buildPayingSession(app, lead, [`g-${uuidv7()}`]);
    await payFee(bill.billId, lead);

    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);

    expect(refundsCreate).not.toHaveBeenCalled();
    expect((await tableFeeStore.get(bill.billId))?.refundedAt).toBeUndefined();
  });

  it('still closes the bill when Stripe refuses the refund', async () => {
    const { stripe, refundsCreate } = fakeStripe(() => Promise.reject(new Error('Stripe down')));
    const app = buildApp(stripe);
    const lead = `c-${uuidv7()}`;
    const { sessionId, billId } = await sharedNobodyJoined(app, lead);

    const res = await post(app, `/v1/sessions/${sessionId}/close`, lead);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('settled');
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    // Not marked refunded: the next close or bin tries again.
    expect((await tableFeeStore.get(billId))?.refundedAt).toBeUndefined();
  });
});

describe('the £1 hold at close (#167)', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  const holdStripe = () => {
    const capture = vi.fn((_id: string, _p: object, _o: object) => Promise.resolve({}));
    const cancel = vi.fn((_id: string, _p: object, _o: object) => Promise.resolve({}));
    const stripe = {
      paymentIntents: { capture, cancel, retrieve: vi.fn() },
      refunds: { create: vi.fn() },
      checkout: { sessions: { retrieve: vi.fn() } },
    } as unknown as Stripe;
    return { stripe, capture, cancel };
  };

  /** Shared on a £1 hold (no credits), and a guest has claimed the pizza (£14.50 of £28.50). */
  async function heldTableWithGuest(stripe: Stripe) {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
      stripe,
      creditStore: null,
    });
    const lead = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const bill = await createBillFor(app, lead);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(lead) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    await tableFeeStore.putIfAbsent({
      billId: bill.billId,
      userId: lead,
      checkoutSessionId: `cs_${bill.billId}`,
      paymentIntentId: `pi_${bill.billId}`,
      kind: 'hold',
      amountPence: 100,
      paidAt: new Date().toISOString(),
    });
    await setPayoutFor(app, lead);
    expect((await post(app, `/v1/sessions/${sessionId}/share`, lead)).status).toBe(200);
    await post(app, `/v1/sessions/${sessionId}/join`, guest);
    const pizza = bill.items.find((i) => i.name === 'Margherita Pizza')!;
    const claim = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [pizza.itemId] }),
    });
    expect(claim.status).toBe(200);
    // The rest of the bill stays unclaimed: the lead lets them pay now (#216).
    expect((await post(app, `/v1/sessions/${sessionId}/open-payments`, lead)).status).toBe(200);
    return { app, lead, guest, sessionId, billId: bill.billId };
  }

  /** The guest pays the lead; returns the payment so the lead can confirm it. */
  async function guestPays(app: ReturnType<typeof createApp>, sessionId: string, guest: string) {
    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guest) },
    });
    expect(res.status).toBe(201);
    const { payment } = (await res.json()) as {
      payment: { paymentId: string; amountPence: number };
    };
    return payment;
  }

  it('closing takes the round-ups of confirmed payments from the hold, once', async () => {
    const { stripe, capture } = holdStripe();
    const { app, lead, guest, sessionId, billId } = await heldTableWithGuest(stripe);
    const payment = await guestPays(app, sessionId, guest);
    // Pizza £14.50 plus service is £16.31, rounded up to £17.00: a 69p round-up.
    expect(payment.amountPence).toBe(1700);
    const confirm = await app.request(`/v1/payments/${payment.paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(lead),
    });
    expect(confirm.status).toBe(200);

    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);
    expect(capture).toHaveBeenCalledWith(
      `pi_${billId}`,
      { amount_to_capture: 69 },
      { idempotencyKey: `table-fee-capture-cs_${billId}` },
    );
    expect(await tableFeeStore.get(billId)).toMatchObject({ capturedPence: 69 });

    await post(app, `/v1/sessions/${sessionId}/close`, lead);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a lead who confirms nobody when guests say they’ve paid is charged the whole hold', async () => {
    const { stripe, capture } = holdStripe();
    const { app, lead, guest, sessionId, billId } = await heldTableWithGuest(stripe);
    const payment = await guestPays(app, sessionId, guest);
    const marked = await app.request(`/v1/payments/${payment.paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(marked.status).toBe(200);

    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);
    expect(capture).toHaveBeenCalledWith(
      `pi_${billId}`,
      { amount_to_capture: 100 },
      { idempotencyKey: `table-fee-capture-cs_${billId}` },
    );
  });

  it('nobody paid: the hold is released', async () => {
    const { stripe, capture, cancel } = holdStripe();
    const { app, lead, sessionId } = await heldTableWithGuest(stripe);

    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('binning a bill guests joined releases the hold: nothing is taken', async () => {
    const { stripe, capture, cancel } = holdStripe();
    const { app, lead, sessionId, billId } = await heldTableWithGuest(stripe);

    expect((await post(app, `/v1/sessions/${sessionId}/abandon`, lead)).status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await tableFeeStore.get(billId))?.releasedAt).toBeDefined();
  });
});
