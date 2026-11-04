import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { Hono } from 'hono';
import {
  checkoutSessionParams,
  createTableFeeService,
  monthOf,
  nextCreditOn,
  type CreditStore,
  type MonthlyCredit,
  feeLookupKeyFor,
  nobodyJoined,
  parseEmailList,
  type TableFee,
  type TableFeeStore,
} from './tableFee.js';
import { buildStripeWebhookRoutes } from '../../routes/stripeWebhook.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import type { Bill } from '../../types/bills.js';

const BILL_ID = '0193ab12-0000-7000-8000-000000000001';
const LEAD = { userId: 'user-lead', displayName: 'Callum', email: 'callum@example.com' };

const bill = (totalPence: number, creatorUserId = LEAD.userId) =>
  ({ billId: BILL_ID, creatorUserId, totalPence }) as unknown as Bill;

const memoryStore = (): TableFeeStore & { rows: Map<string, TableFee> } => {
  const rows = new Map<string, TableFee>();
  return {
    rows,
    get: (billId) => Promise.resolve(rows.get(billId) ?? null),
    // Same rules as the DynamoDB condition in storage/tableFeeStore.ts.
    putIfAbsent: (fee) => {
      const existing = rows.get(fee.billId);
      const replaceable =
        !existing ||
        (!!existing.refundedAt && existing.checkoutSessionId !== fee.checkoutSessionId);
      if (!replaceable) return Promise.resolve('duplicate' as const);
      rows.set(fee.billId, fee);
      return Promise.resolve('recorded' as const);
    },
    markRefunded: (billId, refund) => {
      const existing = rows.get(billId);
      if (!existing || existing.refundedAt) return Promise.resolve('duplicate' as const);
      rows.set(billId, { ...existing, ...refund });
      return Promise.resolve('recorded' as const);
    },
  };
};

const fakeStripe = () => {
  const create = vi.fn(() =>
    Promise.resolve({ id: 'cs_test_1', client_secret: 'cs_test_1_secret_x' }),
  );
  const list = vi.fn(({ lookup_keys }: { lookup_keys: string[] }) =>
    Promise.resolve({
      data: [
        {
          id: `price_${lookup_keys[0]}`,
          unit_amount: lookup_keys[0] === 'table_fee_3' ? 300 : 200,
        },
      ],
    }),
  );
  return {
    stripe: { checkout: { sessions: { create } }, prices: { list } } as unknown as Stripe,
    create,
    list,
  };
};

describe('feeLookupKeyFor', () => {
  it('charges £2 up to £100 and £3 above it', () => {
    expect(feeLookupKeyFor(0)).toBe('table_fee_2');
    expect(feeLookupKeyFor(10_000)).toBe('table_fee_2');
    expect(feeLookupKeyFor(10_001)).toBe('table_fee_3');
  });
});

describe('checkoutSessionParams', () => {
  it('uses the Checkout Studio settings exactly', () => {
    const params = checkoutSessionParams({
      priceId: 'price_x',
      billId: BILL_ID,
      userId: LEAD.userId,
      returnUrl: 'http://localhost:8081/table-fee/x',
    });
    expect(params).toMatchObject({
      ui_mode: 'form',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      submit_type: 'auto',
      name_collection: { individual: { enabled: true, optional: true } },
      integration_identifier: 'custom_embedded_web_0001',
      mode: 'payment',
      line_items: [{ price: 'price_x', quantity: 1 }],
    });
    // Only valid for subscriptions.
    expect(params).not.toHaveProperty('payment_method_collection');
    expect(params).not.toHaveProperty('customer_email');
  });
});

describe('tableFeeService.startCheckout', () => {
  it('picks the £3 price for a bill over £100 and returns the client secret', async () => {
    const { stripe, create, list } = fakeStripe();
    const service = createTableFeeService({
      stripe,
      store: memoryStore(),
      getBill: () => Promise.resolve(bill(11_076)),
      appBaseUrl: 'https://gdp.example',
    });
    const result = await service.startCheckout({ caller: LEAD, billId: BILL_ID });
    expect(result).toEqual({ clientSecret: 'cs_test_1_secret_x', amountPence: 300 });
    expect(list).toHaveBeenCalledWith({ lookup_keys: ['table_fee_3'], active: true, limit: 1 });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_table_fee_3', quantity: 1 }],
        customer_email: LEAD.email,
        client_reference_id: LEAD.userId,
        metadata: { billId: BILL_ID, userId: LEAD.userId },
        return_url: `https://gdp.example/table-fee/${BILL_ID}?session_id={CHECKOUT_SESSION_ID}`,
      }),
    );
  });

  it("refuses someone else's bill", async () => {
    const { stripe } = fakeStripe();
    const service = createTableFeeService({
      stripe,
      store: memoryStore(),
      getBill: () => Promise.resolve(bill(5_000, 'someone-else')),
      appBaseUrl: 'https://gdp.example',
    });
    await expect(service.startCheckout({ caller: LEAD, billId: BILL_ID })).rejects.toMatchObject({
      code: 'BILL_NOT_FOUND',
    });
  });

  it('refuses to charge twice for the same bill', async () => {
    const { stripe, create } = fakeStripe();
    const store = memoryStore();
    store.rows.set(BILL_ID, {
      billId: BILL_ID,
      userId: LEAD.userId,
      checkoutSessionId: 'cs_old',
      amountPence: 200,
      paidAt: '2026-10-31T20:00:00.000Z',
    });
    const service = createTableFeeService({
      stripe,
      store,
      getBill: () => Promise.resolve(bill(5_000)),
      appBaseUrl: 'https://gdp.example',
    });
    await expect(service.startCheckout({ caller: LEAD, billId: BILL_ID })).rejects.toMatchObject({
      code: 'TABLE_FEE_PAID',
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('exempt leads', () => {
  it('parses a comma list, ignoring case, spaces and blanks', () => {
    expect([...parseEmailList(' Callum@Example.com, ,friend@x.co ,not-an-email,')]).toEqual([
      'callum@example.com',
      'friend@x.co',
    ]);
    expect(parseEmailList('').size).toBe(0);
  });

  const service = (exempt: string, store = memoryStore()) => {
    const fake = fakeStripe();
    return {
      ...fake,
      store,
      service: createTableFeeService({
        stripe: fake.stripe,
        store,
        getBill: () => Promise.resolve(bill(12_000)),
        appBaseUrl: 'https://gdp.example',
        exemptEmails: parseEmailList(exempt),
      }),
    };
  };

  it('an exempt lead owes nothing and is never sent to Stripe', async () => {
    const { service: s, create } = service('CALLUM@example.com');
    expect(await s.status({ caller: LEAD, billId: BILL_ID })).toEqual({
      billId: BILL_ID,
      status: 'waived',
      amountPence: 0,
    });
    await expect(s.startCheckout({ caller: LEAD, billId: BILL_ID })).rejects.toMatchObject({
      code: 'TABLE_FEE_WAIVED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('everyone else still pays', async () => {
    const { service: s } = service('someone-else@example.com');
    expect(await s.status({ caller: LEAD, billId: BILL_ID })).toMatchObject({
      status: 'unpaid',
      amountPence: 300,
    });
    const noEmail = { userId: LEAD.userId, displayName: 'Callum' };
    expect(await s.status({ caller: noEmail, billId: BILL_ID })).toMatchObject({
      status: 'unpaid',
    });
  });

  it('a fee paid before the lead was exempted still shows as paid', async () => {
    const store = memoryStore();
    store.rows.set(BILL_ID, {
      billId: BILL_ID,
      userId: LEAD.userId,
      checkoutSessionId: 'cs_old',
      amountPence: 300,
      paidAt: '2026-10-31T20:00:00.000Z',
    });
    const { service: s } = service('callum@example.com', store);
    expect(await s.status({ caller: LEAD, billId: BILL_ID })).toMatchObject({ status: 'paid' });
  });
});

describe('POST /webhooks/stripe', () => {
  const SECRET = 'whsec_test_secret';
  const realStripe = new Stripe('sk_test_unused');

  const completedEvent = (paymentStatus: 'paid' | 'unpaid') => ({
    id: 'evt_1',
    object: 'event',
    type: 'checkout.session.completed',
    created: 1_793_478_000,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_status: paymentStatus,
        payment_intent: 'pi_1',
        amount_total: 300,
        metadata: { billId: BILL_ID, userId: LEAD.userId },
      },
    },
  });

  const setup = () => {
    const store = memoryStore();
    const tableFees = createTableFeeService({
      stripe: realStripe,
      store,
      getBill: () => Promise.resolve(bill(11_076)),
      appBaseUrl: 'https://gdp.example',
    });
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/webhooks',
      buildStripeWebhookRoutes({ stripe: realStripe, webhookSecret: SECRET, tableFees }),
    );
    const send = (payload: string, signature: string) =>
      app.request('/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        body: payload,
      });
    const sign = (payload: string) =>
      realStripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    return { store, send, sign };
  };

  it('records the fee once when a paid checkout completes, even if Stripe resends it', async () => {
    const { store, send, sign } = setup();
    const payload = JSON.stringify(completedEvent('paid'));
    expect((await send(payload, sign(payload))).status).toBe(200);
    expect((await send(payload, sign(payload))).status).toBe(200);
    expect(store.rows.get(BILL_ID)).toEqual({
      billId: BILL_ID,
      userId: LEAD.userId,
      checkoutSessionId: 'cs_test_1',
      paymentIntentId: 'pi_1',
      amountPence: 300,
      paidAt: new Date(1_793_478_000 * 1000).toISOString(),
    });
  });

  it('ignores a completed checkout that is not paid yet', async () => {
    const { store, send, sign } = setup();
    const payload = JSON.stringify(completedEvent('unpaid'));
    expect((await send(payload, sign(payload))).status).toBe(200);
    expect(store.rows.size).toBe(0);
  });

  it('rejects a bad signature', async () => {
    const { store, send } = setup();
    const res = await send(JSON.stringify(completedEvent('paid')), 't=1,v1=bad');
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });
});

describe('tableFeeService.status', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'cs_test_1',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    amount_total: 200,
    metadata: { billId: BILL_ID, userId: LEAD.userId },
    ...over,
  });
  const setup = (retrieved: unknown) => {
    const store = memoryStore();
    const retrieve = vi.fn(() =>
      retrieved instanceof Error ? Promise.reject(retrieved) : Promise.resolve(retrieved),
    );
    const svc = createTableFeeService({
      stripe: { checkout: { sessions: { retrieve } } } as unknown as Stripe,
      store,
      getBill: () => Promise.resolve(bill(5_000)),
      appBaseUrl: 'http://localhost:8081',
    });
    return { store, retrieve, svc };
  };

  it('is unpaid without asking Stripe when no session is given', async () => {
    const { svc, retrieve } = setup(session());
    await expect(svc.status({ caller: LEAD, billId: BILL_ID })).resolves.toEqual({
      billId: BILL_ID,
      status: 'unpaid',
      amountPence: 200,
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('records a paid session when the webhook has not arrived', async () => {
    const { svc, store } = setup(session());
    const res = await svc.status({ caller: LEAD, billId: BILL_ID, checkoutSessionId: 'cs_test_1' });
    expect(res).toMatchObject({ status: 'paid', amountPence: 200 });
    expect(store.rows.get(BILL_ID)).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      paymentIntentId: 'pi_1',
    });
  });

  it('stays unpaid while Stripe still has the session unpaid', async () => {
    const { svc, store } = setup(session({ payment_status: 'unpaid' }));
    const res = await svc.status({ caller: LEAD, billId: BILL_ID, checkoutSessionId: 'cs_test_1' });
    expect(res.status).toBe('unpaid');
    expect(store.rows.size).toBe(0);
  });

  it("won't record a session for another bill or another user", async () => {
    for (const metadata of [
      { billId: 'other-bill', userId: LEAD.userId },
      { billId: BILL_ID, userId: 'someone-else' },
    ]) {
      const { svc, store } = setup(session({ metadata }));
      const res = await svc.status({
        caller: LEAD,
        billId: BILL_ID,
        checkoutSessionId: 'cs_test_1',
      });
      expect(res.status).toBe('unpaid');
      expect(store.rows.size).toBe(0);
    }
  });

  it('stays unpaid when Stripe does not know the session', async () => {
    const { svc } = setup(new Error('No such checkout.session'));
    const res = await svc.status({ caller: LEAD, billId: BILL_ID, checkoutSessionId: 'cs_bad' });
    expect(res.status).toBe('unpaid');
  });
});

/**
 * The Refunds page (apps/web/app/(legal)/refunds/page.tsx): "If nobody
 * joins the bill before you close it or bin it, we refund the fee to your
 * card." These pin the code to that sentence.
 */
describe('refund policy: nobody joined', () => {
  const SESSION_ID = '0193ab12-0000-7000-8000-0000000000aa';
  const GUEST = 'user-guest';
  const paidFee = (over: Partial<TableFee> = {}): TableFee => ({
    billId: BILL_ID,
    userId: LEAD.userId,
    checkoutSessionId: 'cs_paid',
    paymentIntentId: 'pi_paid',
    amountPence: 300,
    paidAt: '2026-11-03T19:00:00.000Z',
    ...over,
  });
  const leadOnly = {
    sessionId: SESSION_ID,
    billId: BILL_ID,
    creatorUserId: LEAD.userId,
    participants: [{ userId: LEAD.userId }],
  };
  const withGuest = { ...leadOnly, participants: [{ userId: LEAD.userId }, { userId: GUEST }] };

  const setup = (fee: TableFee | null = paidFee()) => {
    const store = memoryStore();
    if (fee) store.rows.set(BILL_ID, fee);
    const refundsCreate = vi.fn((_params: object, _opts: object) =>
      Promise.resolve({ id: 're_1', status: 'succeeded' }),
    );
    const retrieve = vi.fn(() =>
      Promise.resolve({ id: 'cs_paid', payment_intent: 'pi_looked_up' }),
    );
    const { stripe: base, create } = fakeStripe();
    const stripe = {
      ...(base as unknown as object),
      refunds: { create: refundsCreate },
      checkout: { sessions: { create, retrieve } },
    } as unknown as Stripe;
    const service = createTableFeeService({
      stripe,
      store,
      getBill: () => Promise.resolve(bill(12_000)),
      appBaseUrl: 'https://gdp.example',
    });
    return { store, service, refundsCreate, retrieve };
  };

  it('counts only people other than the lead as joining', () => {
    expect(nobodyJoined(leadOnly)).toBe(true);
    expect(nobodyJoined({ ...leadOnly, participants: [] })).toBe(true);
    expect(nobodyJoined(withGuest)).toBe(false);
  });

  it('refunds the whole fee to the card it was paid with when nobody joined', async () => {
    const { service, store, refundsCreate } = setup();
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('refunded');
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_paid', reason: 'requested_by_customer' }),
      { idempotencyKey: 'table-fee-refund-cs_paid' },
    );
    // No `amount`: Stripe refunds the full charge, £2 or £3 alike.
    expect(refundsCreate.mock.calls[0]?.[0]).not.toHaveProperty('amount');
    const refunded = store.rows.get(BILL_ID);
    expect(refunded?.refundId).toBe('re_1');
    expect(refunded?.refundedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the fee once anyone has joined', async () => {
    const { service, store, refundsCreate } = setup();
    expect(await service.refundIfNobodyJoined(withGuest)).toBe('guests_joined');
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(store.rows.get(BILL_ID)?.refundedAt).toBeUndefined();
  });

  it('does nothing when no fee was paid (exempt lead, or never paid)', async () => {
    const { service, refundsCreate } = setup(null);
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('no_fee');
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it('refunds once, however many times the bill is closed or binned', async () => {
    const { service, refundsCreate } = setup();
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('refunded');
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('already_refunded');
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("finds the payment from Stripe when the fee row doesn't have it", async () => {
    const { service, refundsCreate, retrieve } = setup(paidFee({ paymentIntentId: undefined }));
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('refunded');
    expect(retrieve).toHaveBeenCalledWith('cs_paid');
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_looked_up' }),
      expect.anything(),
    );
  });

  it('a refunded fee no longer pays for the bill: sharing it again costs a new fee', async () => {
    const { service, store } = setup();
    await service.refundIfNobodyJoined(leadOnly);
    expect(await service.status({ caller: LEAD, billId: BILL_ID })).toMatchObject({
      status: 'unpaid',
      amountPence: 300,
    });
    await expect(service.startCheckout({ caller: LEAD, billId: BILL_ID })).resolves.toMatchObject({
      amountPence: 300,
    });

    // Stripe resending the refunded payment's webhook doesn't bring it back…
    const event = (id: string) =>
      ({
        type: 'checkout.session.completed',
        created: 1_793_478_000,
        data: {
          object: {
            id,
            payment_status: 'paid',
            payment_intent: `pi_${id}`,
            amount_total: 300,
            metadata: { billId: BILL_ID, userId: LEAD.userId },
          },
        },
      }) as unknown as Stripe.Event;
    expect(await service.handleEvent(event('cs_paid'))).toBe('duplicate');
    expect(store.rows.get(BILL_ID)?.refundedAt).toBeDefined();

    // …but a new payment is recorded, and can itself be refunded.
    expect(await service.handleEvent(event('cs_new'))).toBe('applied');
    expect(await service.status({ caller: LEAD, billId: BILL_ID })).toMatchObject({
      status: 'paid',
    });
    expect(await service.refundIfNobodyJoined(leadOnly)).toBe('refunded');
  });
});

describe('monthly credit', () => {
  it('counts months in UK time', () => {
    // 23:30 UTC on 31 Oct is still October in London (GMT); 23:30 UTC on
    // 31 Jul is already 1 Aug (BST).
    expect(monthOf(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
    expect(monthOf(new Date('2026-07-31T23:30:00Z'))).toBe('2026-08');
    expect(nextCreditOn('2026-11')).toBe('2026-12-01');
    expect(nextCreditOn('2026-12')).toBe('2027-01-01');
  });

  const credits = (): CreditStore & { rows: Map<string, MonthlyCredit> } => {
    const rows = new Map<string, MonthlyCredit>();
    return {
      rows,
      get: (userId, month) => Promise.resolve(rows.get(`${userId}#${month}`) ?? null),
      markReturned: (userId, month, sessionId, returnedAt) => {
        const c = rows.get(`${userId}#${month}`);
        if (!c || c.sessionId !== sessionId || c.returnedAt) {
          return Promise.resolve('duplicate' as const);
        }
        rows.set(`${userId}#${month}`, { ...c, returnedAt });
        return Promise.resolve('recorded' as const);
      },
      listForUser: () => Promise.resolve({ fees: [], credits: [...rows.values()] }),
    };
  };

  const setup = () => {
    const store = memoryStore();
    const creditStore = credits();
    const service = createTableFeeService({
      stripe: fakeStripe().stripe,
      store,
      credits: creditStore,
      getBill: () => Promise.resolve(bill(5_000)),
      appBaseUrl: 'https://gdp.example',
      now: () => new Date('2026-11-04T12:00:00Z'),
    });
    return { store, creditStore, service };
  };

  it('a lead with this month’s credit shares free; the entitlement is the credit', async () => {
    const { service } = setup();
    expect(await service.status({ caller: LEAD, billId: BILL_ID })).toEqual({
      billId: BILL_ID,
      status: 'free',
      amountPence: 0,
      creditsLeft: 1,
      nextCreditOn: '2026-12-01',
    });
    expect(
      await service.shareEntitlement({ caller: LEAD, billId: BILL_ID, sessionId: 's1' }),
    ).toMatchObject({ kind: 'credit', credit: { month: '2026-11', sessionId: 's1' } });
    expect(await service.summary(LEAD)).toMatchObject({ creditsLeft: 1 });
  });

  it('a spent credit means the fee is due, except for the session that spent it', async () => {
    const { service, creditStore } = setup();
    creditStore.rows.set(`${LEAD.userId}#2026-11`, {
      userId: LEAD.userId,
      month: '2026-11',
      billId: 'other',
      sessionId: 's1',
      claimedAt: '2026-11-01T10:00:00Z',
    });
    expect(await service.status({ caller: LEAD, billId: BILL_ID })).toMatchObject({
      status: 'unpaid',
      amountPence: 200,
      creditsLeft: 0,
    });
    await expect(
      service.shareEntitlement({ caller: LEAD, billId: BILL_ID, sessionId: 's2' }),
    ).rejects.toMatchObject({ code: 'TABLE_FEE_REQUIRED' });
    expect(await service.status({ caller: LEAD, billId: BILL_ID, sessionId: 's1' })).toMatchObject({
      status: 'free',
    });
    expect(await service.summary(LEAD)).toMatchObject({ creditsLeft: 0, paidPence: 0 });
  });

  it('the account sums the fees paid and refunded', async () => {
    const { service, creditStore } = setup();
    creditStore.listForUser = () =>
      Promise.resolve({
        fees: [
          {
            billId: 'b1',
            userId: LEAD.userId,
            checkoutSessionId: 'cs_1',
            amountPence: 300,
            paidAt: '2026-11-02T10:00:00Z',
            sessionId: 's1',
          },
          {
            billId: 'b2',
            userId: LEAD.userId,
            checkoutSessionId: 'cs_2',
            amountPence: 200,
            paidAt: '2026-11-01T10:00:00Z',
            refundId: 're_2',
            refundedAt: '2026-11-01T11:00:00Z',
          },
        ],
        credits: [],
      });
    expect(await service.summary(LEAD)).toEqual({
      creditsLeft: 1,
      nextCreditOn: '2026-12-01',
      paidPence: 500,
      refundedPence: 200,
      fees: [
        { billId: 'b1', sessionId: 's1', amountPence: 300, paidAt: '2026-11-02T10:00:00Z' },
        {
          billId: 'b2',
          amountPence: 200,
          paidAt: '2026-11-01T10:00:00Z',
          refundedAt: '2026-11-01T11:00:00Z',
        },
      ],
      credits: [],
    });
  });

  it('closing with nobody joined hands the credit back, and leaves a fee spent elsewhere alone', async () => {
    const { service, creditStore, store } = setup();
    creditStore.rows.set(`${LEAD.userId}#2026-11`, {
      userId: LEAD.userId,
      month: '2026-11',
      billId: BILL_ID,
      sessionId: 's2',
      claimedAt: '2026-11-01T10:00:00Z',
    });
    store.rows.set(BILL_ID, {
      billId: BILL_ID,
      userId: LEAD.userId,
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      amountPence: 200,
      paidAt: '2026-11-01T09:00:00Z',
      sessionId: 's1',
    });
    const outcome = await service.refundIfNobodyJoined({
      sessionId: 's2',
      billId: BILL_ID,
      creatorUserId: LEAD.userId,
      participants: [{ userId: LEAD.userId }],
    });
    expect(outcome).toBe('credit_returned');
    expect(creditStore.rows.get(`${LEAD.userId}#2026-11`)?.returnedAt).toBe(
      '2026-11-04T12:00:00.000Z',
    );
    expect(store.rows.get(BILL_ID)?.refundedAt).toBeUndefined();
  });
});
