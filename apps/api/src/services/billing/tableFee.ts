import type Stripe from 'stripe';
import { AppError } from '../../errors/AppError.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Bill } from '../../types/bills.js';

/** Bills over £100 cost £3 to share; up to £100, £2. */
export const FEE_THRESHOLD_PENCE = 10_000;

/** Stripe price lookup keys, set up on the *Table fee* product in the Dashboard. */
export type FeeLookupKey = 'table_fee_2' | 'table_fee_3';

export const feeLookupKeyFor = (billTotalPence: number): FeeLookupKey =>
  billTotalPence > FEE_THRESHOLD_PENCE ? 'table_fee_3' : 'table_fee_2';

export interface TableFee {
  billId: string;
  userId: string;
  checkoutSessionId: string;
  paymentIntentId?: string;
  amountPence: number;
  paidAt: string;
}

export interface TableFeeStore {
  get(billId: string): Promise<TableFee | null>;
  /** Idempotent: a second write for the same bill is ignored. */
  putIfAbsent(fee: TableFee): Promise<'recorded' | 'duplicate'>;
}

/**
 * Checkout Session for the embedded form. The `fixed_by_ui` values come from
 * the Checkout Studio configuration and must stay as they are.
 */
export const checkoutSessionParams = (input: {
  priceId: string;
  billId: string;
  userId: string;
  email?: string;
  returnUrl: string;
}): Stripe.Checkout.SessionCreateParams => ({
  // fixed_by_ui (Checkout Studio)
  ui_mode: 'form',
  billing_address_collection: 'auto',
  phone_number_collection: { enabled: false },
  automatic_tax: { enabled: false },
  submit_type: 'auto',
  name_collection: { individual: { enabled: true, optional: true } },
  integration_identifier: 'custom_embedded_web_0001',
  // ours
  mode: 'payment',
  line_items: [{ price: input.priceId, quantity: 1 }],
  return_url: input.returnUrl,
  client_reference_id: input.userId,
  metadata: { billId: input.billId, userId: input.userId },
  payment_intent_data: { metadata: { billId: input.billId, userId: input.userId } },
  ...(input.email ? { customer_email: input.email } : {}),
});

export interface TableFeeServiceDeps {
  stripe: Stripe;
  store: TableFeeStore;
  getBill: (billId: string) => Promise<Bill | null>;
  appBaseUrl: string;
}

export type TableFeeStatus =
  | { billId: string; status: 'paid'; amountPence: number; paidAt: string }
  | { billId: string; status: 'unpaid'; amountPence: number };

export const createTableFeeService = (deps: TableFeeServiceDeps) => {
  const loadOwnBill = async (billId: string, caller: VerifiedCaller): Promise<Bill> => {
    const bill = await deps.getBill(billId);
    if (!bill || bill.creatorUserId !== caller.userId) {
      throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    }
    return bill;
  };

  const priceFor = async (bill: Bill): Promise<Stripe.Price> => {
    const lookupKey = feeLookupKeyFor(bill.totalPence);
    const prices = await deps.stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price || price.unit_amount == null) {
      throw new AppError(
        'PAYMENT_PROVIDER_ERROR',
        `No active Stripe price with lookup key ${lookupKey}`,
      );
    }
    return price;
  };

  const startCheckoutUnsafe = async (input: { caller: VerifiedCaller; billId: string }) => {
    const bill = await loadOwnBill(input.billId, input.caller);
    if (await deps.store.get(bill.billId)) {
      throw new AppError('TABLE_FEE_PAID', 'The fee for this bill is already paid');
    }
    const price = await priceFor(bill);
    const returnUrl = `${deps.appBaseUrl}/table-fee/${bill.billId}?session_id={CHECKOUT_SESSION_ID}`;
    const session = await deps.stripe.checkout.sessions.create(
      checkoutSessionParams({
        priceId: price.id,
        billId: bill.billId,
        userId: input.caller.userId,
        ...(input.caller.email ? { email: input.caller.email } : {}),
        returnUrl,
      }),
    );
    if (!session.client_secret) {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Stripe returned no client secret');
    }
    return { clientSecret: session.client_secret, amountPence: price.unit_amount ?? 0 };
  };

  return {
    /** Starts the embedded checkout for this bill's fee and returns the form's client secret. */
    async startCheckout(input: { caller: VerifiedCaller; billId: string }) {
      try {
        return await startCheckoutUnsafe(input);
      } catch (err) {
        if (err instanceof AppError) throw err;
        // A Stripe error (bad key, test/live mix-up, missing price, a
        // parameter this account doesn't support): show its message
        // instead of "internal error", which says nothing.
        const e = err as { type?: string; message?: string };
        if (e.type?.startsWith('Stripe')) {
          throw new AppError('PAYMENT_PROVIDER_ERROR', `Stripe: ${e.message ?? e.type}`);
        }
        throw err;
      }
    },

    async status(input: { caller: VerifiedCaller; billId: string }): Promise<TableFeeStatus> {
      const bill = await loadOwnBill(input.billId, input.caller);
      const fee = await deps.store.get(bill.billId);
      if (fee)
        return {
          billId: bill.billId,
          status: 'paid',
          amountPence: fee.amountPence,
          paidAt: fee.paidAt,
        };
      const amountPence = feeLookupKeyFor(bill.totalPence) === 'table_fee_3' ? 300 : 200;
      return { billId: bill.billId, status: 'unpaid', amountPence };
    },

    /** Applies a verified Stripe event. Safe to receive the same event twice. */
    async handleEvent(event: Stripe.Event): Promise<'applied' | 'duplicate' | 'ignored'> {
      if (
        event.type !== 'checkout.session.completed' &&
        event.type !== 'checkout.session.async_payment_succeeded'
      ) {
        return 'ignored';
      }
      const session = event.data.object;
      const billId = session.metadata?.billId;
      const userId = session.metadata?.userId;
      if (session.payment_status !== 'paid' || !billId || !userId) return 'ignored';
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
      const result = await deps.store.putIfAbsent({
        billId,
        userId,
        checkoutSessionId: session.id,
        ...(paymentIntentId ? { paymentIntentId } : {}),
        amountPence: session.amount_total ?? 0,
        paidAt: new Date(event.created * 1000).toISOString(),
      });
      return result === 'recorded' ? 'applied' : 'duplicate';
    },
  };
};

export type TableFeeService = ReturnType<typeof createTableFeeService>;
