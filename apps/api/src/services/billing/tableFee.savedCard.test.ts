import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  checkoutSessionParams,
  createTableFeeService,
  type SavedCard,
  type SavedCardStore,
  type TableFee,
  type TableFeeStore,
} from './tableFee.js';
import { renderConfirmChargeEmail } from './confirmChargeEmail.js';
import type { Bill } from '../../types/bills.js';

/**
 * #228: the £1 hold saves the lead's card; at settle the hold is always
 * released and the saved card is charged the guests' round-ups, no cap.
 */

const BILL_ID = '0193ab12-0000-7000-8000-000000000001';
const SESSION_ID = '0193ab12-0000-7000-8000-0000000000cc';
const LEAD = { userId: 'user-lead', displayName: 'Callum', email: 'callum@example.com' };
const NOW = new Date('2026-11-08T20:00:00.000Z');

const memoryStore = (): TableFeeStore & { rows: Map<string, TableFee> } => {
  const rows = new Map<string, TableFee>();
  return {
    rows,
    get: (billId) => Promise.resolve(rows.get(billId) ?? null),
    putIfAbsent: (fee) => {
      if (rows.has(fee.billId)) return Promise.resolve('duplicate' as const);
      rows.set(fee.billId, fee);
      return Promise.resolve('recorded' as const);
    },
    markReleased: (billId, releasedAt) => {
      const f = rows.get(billId);
      if (!f || f.releasedAt) return Promise.resolve('duplicate' as const);
      rows.set(billId, { ...f, releasedAt });
      return Promise.resolve('recorded' as const);
    },
    markCaptured: (billId, capture) => {
      const f = rows.get(billId);
      if (!f || f.capturedAt || f.releasedAt) return Promise.resolve('duplicate' as const);
      rows.set(billId, { ...f, ...capture });
      return Promise.resolve('recorded' as const);
    },
    markCharge: (billId, charge) => {
      const f = rows.get(billId);
      const ok =
        !!f &&
        (!f.chargeStatus ||
          (charge.chargeStatus === 'charged' && f.chargeStatus === 'needs_confirming'));
      if (!ok) return Promise.resolve('duplicate' as const);
      rows.set(billId, { ...f, ...charge });
      return Promise.resolve('recorded' as const);
    },
    setChargeIntent: (billId, chargeIntentId) => {
      const f = rows.get(billId);
      if (f) rows.set(billId, { ...f, chargeIntentId });
      return Promise.resolve();
    },
    markRefunded: () => Promise.resolve('duplicate' as const),
  };
};

const cardStore = (initial?: SavedCard): SavedCardStore & { rows: Map<string, SavedCard> } => {
  const rows = new Map<string, SavedCard>();
  if (initial) rows.set(initial.userId, initial);
  return {
    rows,
    get: (userId) => Promise.resolve(rows.get(userId) ?? null),
    put: (card) => {
      rows.set(card.userId, card);
      return Promise.resolve();
    },
  };
};

const savedHold: TableFee = {
  billId: BILL_ID,
  userId: LEAD.userId,
  checkoutSessionId: 'cs_hold',
  paymentIntentId: 'pi_hold',
  kind: 'hold',
  amountPence: 100,
  paidAt: '2026-11-04T19:00:00.000Z',
  sessionId: SESSION_ID,
  customerId: 'cus_lead',
  paymentMethodId: 'pm_visa',
};

const table = {
  sessionId: SESSION_ID,
  billId: BILL_ID,
  creatorUserId: LEAD.userId,
  participants: [{ userId: LEAD.userId }, { userId: 'sam' }, { userId: 'tom' }],
};

const cardError = (code: string, intentId?: string) =>
  Object.assign(new Error('Your card was declined.'), {
    type: 'StripeCardError',
    code,
    ...(intentId ? { payment_intent: { id: intentId } } : {}),
  });

const setup = (opts: { fee?: TableFee | null; card?: SavedCard } = {}) => {
  const store = memoryStore();
  if (opts.fee !== null) store.rows.set(BILL_ID, opts.fee ?? savedHold);
  const cards = cardStore(opts.card);
  const create = vi.fn((_p: Stripe.PaymentIntentCreateParams, _o?: object) =>
    Promise.resolve({
      id: 'pi_charge',
      status: 'succeeded',
      amount_received: _p.amount,
    } as unknown as Stripe.PaymentIntent),
  );
  const cancel = vi.fn((_id: string, _p: object, _o: object) => Promise.resolve({}));
  const capture = vi.fn((_id: string, _p: object, _o: object) => Promise.resolve({}));
  const retrieve = vi.fn((_id: string) =>
    Promise.resolve({ id: _id, status: 'requires_payment_method', client_secret: 'pi_x_secret' }),
  );
  const customers = { create: vi.fn(() => Promise.resolve({ id: 'cus_new' })) };
  const paymentMethods = {
    retrieve: vi.fn(() =>
      Promise.resolve({ id: 'pm_visa', card: { brand: 'visa', last4: '4417', wallet: null } }),
    ),
    detach: vi.fn(() => Promise.resolve({})),
  };
  const checkoutCreate = vi.fn(() =>
    Promise.resolve({ id: 'cs_new', client_secret: 'cs_new_secret_x' }),
  );
  const notify = vi.fn((_i: object) => Promise.resolve());
  const stripe = {
    paymentIntents: { create, cancel, capture, retrieve },
    customers,
    paymentMethods,
    checkout: { sessions: { create: checkoutCreate } },
  } as unknown as Stripe;
  const service = createTableFeeService({
    stripe,
    store,
    cards,
    notifyNeedsConfirming: notify,
    getBill: () => Promise.resolve({ billId: BILL_ID, creatorUserId: LEAD.userId } as Bill),
    appBaseUrl: 'https://gdp.example',
    now: () => NOW,
  });
  return {
    store,
    cards,
    service,
    create,
    cancel,
    capture,
    retrieve,
    customers,
    paymentMethods,
    checkoutCreate,
    notify,
  };
};

describe('#228 the hold saves the card', () => {
  it('the Checkout Session is for the lead’s customer and keeps the card for later', () => {
    const p = checkoutSessionParams({
      amountPence: 100,
      billId: BILL_ID,
      userId: LEAD.userId,
      email: LEAD.email,
      customerId: 'cus_lead',
      returnUrl: 'https://gdp.example/x',
    });
    expect(p.customer).toBe('cus_lead');
    expect(p.customer_email).toBeUndefined();
    expect(p.payment_intent_data?.setup_future_usage).toBe('off_session');
    expect(p.payment_intent_data?.capture_method).toBe('manual');
  });

  it('makes the lead’s Stripe customer once, then reuses it', async () => {
    const { service, customers, checkoutCreate, cards } = setup({ fee: null });
    await service.startCheckout({ caller: LEAD, billId: BILL_ID });
    await service.startCheckout({ caller: LEAD, billId: BILL_ID });
    expect(customers.create).toHaveBeenCalledTimes(1);
    expect(customers.create).toHaveBeenCalledWith(
      { email: LEAD.email, metadata: { userId: LEAD.userId } },
      { idempotencyKey: `customer-${LEAD.userId}` },
    );
    expect(cards.rows.get(LEAD.userId)?.customerId).toBe('cus_new');
    const calls = checkoutCreate.mock.calls as unknown as [Stripe.Checkout.SessionCreateParams][];
    expect(calls[1]![0].customer).toBe('cus_new');
  });

  it('an authorised hold keeps the customer and card, and Account shows Visa ending 4417', async () => {
    const { service, store, retrieve } = setup({ fee: null });
    retrieve.mockResolvedValueOnce({
      id: 'pi_hold',
      status: 'requires_capture',
      amount_capturable: 100,
      customer: 'cus_lead',
      payment_method: 'pm_visa',
      setup_future_usage: 'off_session',
    } as never);
    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      created: NOW.getTime() / 1000,
      data: {
        object: {
          id: 'cs_hold',
          status: 'complete',
          payment_intent: 'pi_hold',
          metadata: { billId: BILL_ID, userId: LEAD.userId, kind: 'hold' },
        },
      },
    } as unknown as Stripe.Event;
    expect(await service.handleEvent(event)).toBe('applied');
    expect(store.rows.get(BILL_ID)).toMatchObject({
      customerId: 'cus_lead',
      paymentMethodId: 'pm_visa',
    });
    const summary = await service.summary(LEAD);
    expect(summary.card).toEqual({ brand: 'visa', last4: '4417' });
  });
});

describe('#228 at settle: release the hold, charge the saved card the round-ups', () => {
  it('charges exactly the round-ups (£1.84, no cap) off-session, once per session, and releases the hold', async () => {
    const { service, store, create, cancel } = setup();
    expect(await service.takeFromHold(table, 184)).toBe('charged');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 184,
        currency: 'gbp',
        customer: 'cus_lead',
        payment_method: 'pm_visa',
        off_session: true,
        confirm: true,
        metadata: expect.objectContaining({ kind: 'roundups', sessionId: SESSION_ID }) as object,
      }),
      { idempotencyKey: `table-fee-charge-${SESSION_ID}` },
    );
    expect(cancel).toHaveBeenCalledWith(
      'pi_hold',
      { cancellation_reason: 'abandoned' },
      { idempotencyKey: 'table-fee-release-cs_hold' },
    );
    expect(store.rows.get(BILL_ID)).toMatchObject({
      chargeStatus: 'charged',
      chargePence: 184,
      chargeIntentId: 'pi_charge',
      releasedAt: NOW.toISOString(),
    });
    // A retry (the next close, the sweep) charges nothing more.
    expect(await service.takeFromHold(table, 184)).toBe('already_settled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('under 30p, or nobody paid: nothing is charged and the hold is released', async () => {
    for (const owed of [0, 29]) {
      const { service, store, create, cancel } = setup();
      expect(await service.takeFromHold(table, owed)).toBe('released');
      expect(create).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(store.rows.get(BILL_ID)).toMatchObject({ chargeStatus: 'none', chargePence: 0 });
    }
  });

  it('the bank wants the lead to confirm: needs confirming, an email with the link, and the hold still released', async () => {
    const { service, store, create, cancel, notify } = setup();
    create.mockRejectedValueOnce(cardError('authentication_required', 'pi_charge'));
    expect(await service.takeFromHold(table, 184)).toBe('needs_confirming');
    expect(store.rows.get(BILL_ID)).toMatchObject({
      chargeStatus: 'needs_confirming',
      chargePence: 184,
      chargeIntentId: 'pi_charge',
    });
    expect(notify).toHaveBeenCalledWith({
      userId: LEAD.userId,
      billId: BILL_ID,
      sessionId: SESSION_ID,
      amountPence: 184,
      confirmUrl: `https://gdp.example/fee-charge/${BILL_ID}`,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    // Retrying doesn't charge or email again.
    expect(await service.takeFromHold(table, 184)).toBe('already_settled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a Stripe outage (not a card error) leaves the hold for the next try', async () => {
    const { service, store, create, cancel } = setup();
    create.mockRejectedValueOnce(Object.assign(new Error('down'), { type: 'StripeAPIError' }));
    await expect(service.takeFromHold(table, 184)).rejects.toThrow('down');
    expect(cancel).not.toHaveBeenCalled();
    expect(store.rows.get(BILL_ID)?.chargeStatus).toBeUndefined();
    expect(await service.takeFromHold(table, 184)).toBe('charged');
    expect(create).toHaveBeenLastCalledWith(expect.anything(), {
      idempotencyKey: `table-fee-charge-${SESSION_ID}`,
    });
  });

  it('a hold the sweep already released is still charged at settle', async () => {
    const { service, store, cancel } = setup({
      fee: { ...savedHold, releasedAt: '2026-11-07T03:17:00.000Z' },
    });
    expect(await service.takeFromHold(table, 184)).toBe('charged');
    expect(cancel).not.toHaveBeenCalled();
    expect(store.rows.get(BILL_ID)?.chargePence).toBe(184);
  });

  it('a hold from before #228 (no saved card) is still taken from, at most £1', async () => {
    const legacy: TableFee = { ...savedHold };
    delete legacy.customerId;
    delete legacy.paymentMethodId;
    const { service, create, capture } = setup({ fee: legacy });
    expect(await service.takeFromHold(table, 184)).toBe('captured');
    expect(capture).toHaveBeenCalledWith(
      'pi_hold',
      { amount_to_capture: 100 },
      { idempotencyKey: 'table-fee-capture-cs_hold' },
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('#228 confirming the charge', () => {
  const needs: TableFee = {
    ...savedHold,
    releasedAt: NOW.toISOString(),
    chargeStatus: 'needs_confirming',
    chargePence: 184,
    chargeIntentId: 'pi_charge',
  };

  it('gives the page the client secret and the saved card', async () => {
    const { service } = setup({
      fee: needs,
      card: {
        userId: LEAD.userId,
        customerId: 'cus_lead',
        paymentMethodId: 'pm_visa',
        brand: 'visa',
        last4: '4417',
      },
    });
    expect(await service.feeCharge({ caller: LEAD, billId: BILL_ID })).toEqual({
      billId: BILL_ID,
      status: 'needs_confirming',
      amountPence: 184,
      clientSecret: 'pi_x_secret',
      paymentMethodId: 'pm_visa',
      card: { brand: 'visa', last4: '4417' },
    });
  });

  it('once Stripe says it succeeded, it’s charged', async () => {
    const { service, store, retrieve } = setup({ fee: needs });
    retrieve.mockResolvedValueOnce({
      id: 'pi_charge',
      status: 'succeeded',
      amount_received: 184,
    } as never);
    expect((await service.feeCharge({ caller: LEAD, billId: BILL_ID })).status).toBe('charged');
    expect(store.rows.get(BILL_ID)).toMatchObject({ chargeStatus: 'charged', chargePence: 184 });
  });

  it('no usable PaymentIntent: makes one for the lead to confirm', async () => {
    const { service, store, create } = setup({
      fee: { ...needs, chargeIntentId: undefined },
    });
    create.mockResolvedValueOnce({
      id: 'pi_new',
      status: 'requires_payment_method',
      client_secret: 'pi_new_secret',
    } as never);
    const out = await service.feeCharge({ caller: LEAD, billId: BILL_ID });
    expect(out.clientSecret).toBe('pi_new_secret');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 184 }), {
      idempotencyKey: `table-fee-charge-confirm-${BILL_ID}`,
    });
    expect(store.rows.get(BILL_ID)?.chargeIntentId).toBe('pi_new');
  });

  it('is the lead’s only', async () => {
    const { service } = setup({ fee: needs });
    await expect(
      service.feeCharge({ caller: { userId: 'someone', displayName: 'X' }, billId: BILL_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the webhook records a charge confirmed in the page', async () => {
    const { service, store } = setup({ fee: needs });
    const event = {
      id: 'evt_2',
      type: 'payment_intent.succeeded',
      created: NOW.getTime() / 1000,
      data: {
        object: {
          id: 'pi_charge',
          amount_received: 184,
          metadata: { kind: 'roundups', billId: BILL_ID },
        },
      },
    } as unknown as Stripe.Event;
    expect(await service.handleEvent(event)).toBe('applied');
    expect(store.rows.get(BILL_ID)).toMatchObject({ chargeStatus: 'charged' });
    expect(await service.handleEvent(event)).toBe('duplicate');
  });

  it('the email names the amount and links to the confirm page', () => {
    const e = renderConfirmChargeEmail({
      amountPence: 184,
      confirmUrl: 'https://gdp.example/fee-charge/b',
    });
    expect(e.subject).toBe('Confirm your £1.84 platform fee');
    expect(e.text).toContain('https://gdp.example/fee-charge/b');
    expect(e.html).toContain('href="https://gdp.example/fee-charge/b"');
  });
});

describe('#228 the next hold on the saved card', () => {
  const card: SavedCard = {
    userId: LEAD.userId,
    customerId: 'cus_lead',
    paymentMethodId: 'pm_visa',
    brand: 'visa',
    last4: '4417',
  };

  it('one tap: held, recorded with the card', async () => {
    const { service, store, create } = setup({ fee: null, card });
    create.mockResolvedValueOnce({
      id: 'pi_hold2',
      status: 'requires_capture',
      amount_capturable: 100,
      customer: 'cus_lead',
      payment_method: 'pm_visa',
      metadata: { savedCard: 'true' },
    } as never);
    expect(await service.holdOnSavedCard({ caller: LEAD, billId: BILL_ID })).toEqual({
      status: 'held',
      amountPence: 100,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        capture_method: 'manual',
        customer: 'cus_lead',
        payment_method: 'pm_visa',
        confirm: true,
      }),
    );
    expect(store.rows.get(BILL_ID)).toMatchObject({
      kind: 'hold',
      paymentIntentId: 'pi_hold2',
      checkoutSessionId: 'pi_hold2',
      paymentMethodId: 'pm_visa',
    });
  });

  it('3D Secure: the page finishes it, then the poll records it from Stripe', async () => {
    const { service, store, create, retrieve } = setup({ fee: null, card });
    create.mockResolvedValueOnce({
      id: 'pi_hold3',
      status: 'requires_action',
      client_secret: 'pi_hold3_secret',
    } as never);
    expect(await service.holdOnSavedCard({ caller: LEAD, billId: BILL_ID })).toEqual({
      status: 'requires_action',
      clientSecret: 'pi_hold3_secret',
      paymentIntentId: 'pi_hold3',
    });
    retrieve.mockResolvedValueOnce({
      id: 'pi_hold3',
      status: 'requires_capture',
      amount_capturable: 100,
      customer: 'cus_lead',
      payment_method: 'pm_visa',
      metadata: { kind: 'hold', billId: BILL_ID, userId: LEAD.userId, savedCard: 'true' },
    } as never);
    const status = await service.status({
      caller: LEAD,
      billId: BILL_ID,
      paymentIntentId: 'pi_hold3',
    });
    expect(status.status).toBe('held');
    expect(store.rows.get(BILL_ID)?.paymentIntentId).toBe('pi_hold3');
  });

  it('a declined card says to use another', async () => {
    const { service, create } = setup({ fee: null, card });
    create.mockRejectedValueOnce(cardError('card_declined'));
    await expect(service.holdOnSavedCard({ caller: LEAD, billId: BILL_ID })).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
      message: 'Your card didn’t go through. Use another card.',
    });
  });

  it('no saved card: 404', async () => {
    const { service } = setup({ fee: null });
    await expect(service.holdOnSavedCard({ caller: LEAD, billId: BILL_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('Remove detaches it and keeps the customer', async () => {
    const { service, cards, paymentMethods } = setup({ fee: null, card });
    await service.removeCard(LEAD);
    expect(paymentMethods.detach).toHaveBeenCalledWith('pm_visa');
    expect(cards.rows.get(LEAD.userId)).toEqual({ userId: LEAD.userId, customerId: 'cus_lead' });
    expect((await service.summary(LEAD)).card).toBeUndefined();
  });
});
