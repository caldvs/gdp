/**
 * The Refunds page promises: "If nobody joins the bill before you close it
 * or bin it, we refund the fee to your card." These run that promise through
 * the real close and abandon routes and the real fee row in DynamoDB, with
 * only Stripe faked.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
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
