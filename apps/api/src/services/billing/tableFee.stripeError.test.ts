import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { createTableFeeService, type TableFeeStore } from './tableFee.js';
import type { Bill } from '../../types/bills.js';

const BILL_ID = '0193ab12-0000-7000-8000-000000000001';
const LEAD = { userId: 'user-lead', displayName: 'Callum', email: 'callum@example.com' };
const store: TableFeeStore = {
  get: () => Promise.resolve(null),
  putIfAbsent: () => Promise.resolve('recorded'),
  markRefunded: () => Promise.resolve('recorded'),
};

describe('tableFeeService.startCheckout: Stripe errors (#155)', () => {
  it('a Stripe error reaches the client as a plain message, not Stripe’s own', async () => {
    const stripeError = Object.assign(new Error('No such price: price_123 (secret detail)'), {
      type: 'StripeInvalidRequestError',
    });
    const stripe = {
      prices: { list: () => Promise.reject(stripeError) },
    } as unknown as Stripe;
    const service = createTableFeeService({
      stripe,
      store,
      getBill: () =>
        Promise.resolve({ billId: BILL_ID, creatorUserId: LEAD.userId, totalPence: 5_000 } as Bill),
      appBaseUrl: 'https://gdp.example',
    });
    const err: unknown = await service
      .startCheckout({ caller: LEAD, billId: BILL_ID })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
    expect((err as Error).message).not.toContain('price_123');
    expect((err as Error).message).not.toContain('Stripe');
  });
});
