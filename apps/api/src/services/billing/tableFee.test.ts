import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { Hono } from 'hono';
import {
  checkoutSessionParams,
  createTableFeeService,
  feeLookupKeyFor,
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
    putIfAbsent: (fee) => {
      if (rows.has(fee.billId)) return Promise.resolve('duplicate' as const);
      rows.set(fee.billId, fee);
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
