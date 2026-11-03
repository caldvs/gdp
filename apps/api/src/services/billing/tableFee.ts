import type Stripe from 'stripe';
import { AppError } from '../../errors/AppError.js';
import { timed } from '../../logging/timed.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Bill } from '../../types/bills.js';

/** Bills over £100 cost £3 to share; up to £100, £2. */
export const FEE_THRESHOLD_PENCE = 10_000;

/** Stripe price lookup keys, set up on the *Table fee* product in the Dashboard. */
export type FeeLookupKey = 'table_fee_2' | 'table_fee_3';

export const feeLookupKeyFor = (billTotalPence: number): FeeLookupKey =>
  billTotalPence > FEE_THRESHOLD_PENCE ? 'table_fee_3' : 'table_fee_2';

export { parseEmailList } from '../../config/exemptEmails.js';

export interface TableFee {
  billId: string;
  userId: string;
  checkoutSessionId: string;
  paymentIntentId?: string;
  amountPence: number;
  paidAt: string;
  /** Set once the fee has gone back to the lead's card. */
  refundId?: string;
  refundedAt?: string;
}

export interface TableFeeStore {
  get(billId: string): Promise<TableFee | null>;
  /**
   * Idempotent: a second write for the same Checkout Session is ignored.
   * A refunded fee can be replaced by a new payment (the lead shares the
   * bill again), but never by its own, already refunded, Checkout Session.
   */
  putIfAbsent(fee: TableFee): Promise<'recorded' | 'duplicate'>;
  /** Marks the fee refunded, once. `duplicate` if it already was, or there's no fee. */
  markRefunded(
    billId: string,
    refund: { refundId: string; refundedAt: string },
  ): Promise<'recorded' | 'duplicate'>;
}

/** What `refundIfNobodyJoined` did, for logs and tests. */
export type RefundOutcome =
  'refunded' | 'guests_joined' | 'no_fee' | 'already_refunded' | 'no_payment_intent';

/** The parts of a session the refund policy looks at. */
export interface ClosedSession {
  sessionId: string;
  billId: string;
  creatorUserId: string;
  participants: ReadonlyArray<{ userId: string }>;
}

/**
 * The Refunds page: "If nobody joins the bill before you close it or bin
 * it, we refund the fee to your card." Anyone other than the lead in the
 * session counts as joining.
 */
export const nobodyJoined = (session: ClosedSession): boolean =>
  session.participants.every((p) => p.userId === session.creatorUserId);

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
  /** Leads who never pay the fee (lower case). */
  exemptEmails?: ReadonlySet<string>;
}

export type TableFeeStatus =
  | { billId: string; status: 'paid'; amountPence: number; paidAt: string }
  | { billId: string; status: 'unpaid'; amountPence: number }
  | { billId: string; status: 'waived'; amountPence: 0 };

export const createTableFeeService = (deps: TableFeeServiceDeps) => {
  const isExempt = (caller: VerifiedCaller): boolean =>
    !!caller.email && !!deps.exemptEmails?.has(caller.email.trim().toLowerCase());

  const loadOwnBill = async (billId: string, caller: VerifiedCaller): Promise<Bill> => {
    const bill = await deps.getBill(billId);
    if (!bill || bill.creatorUserId !== caller.userId) {
      throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    }
    return bill;
  };

  const priceFor = async (bill: Bill): Promise<Stripe.Price> => {
    const lookupKey = feeLookupKeyFor(bill.totalPence);
    const prices = await timed('stripe', 'prices.list', () =>
      deps.stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 }),
    );
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
    const existing = await deps.store.get(bill.billId);
    if (existing && !existing.refundedAt) {
      throw new AppError('TABLE_FEE_PAID', 'The fee for this bill is already paid');
    }
    if (isExempt(input.caller)) {
      throw new AppError('TABLE_FEE_WAIVED', 'No fee is due: this account is exempt');
    }
    const price = await priceFor(bill);
    const returnUrl = `${deps.appBaseUrl}/table-fee/${bill.billId}?session_id={CHECKOUT_SESSION_ID}`;
    const session = await timed('stripe', 'checkout.sessions.create', () =>
      deps.stripe.checkout.sessions.create(
        checkoutSessionParams({
          priceId: price.id,
          billId: bill.billId,
          userId: input.caller.userId,
          ...(input.caller.email ? { email: input.caller.email } : {}),
          returnUrl,
        }),
      ),
    );
    if (!session.client_secret) {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Stripe returned no client secret');
    }
    return { clientSecret: session.client_secret, amountPence: price.unit_amount ?? 0 };
  };

  /** Records a paid Checkout Session for its bill. Safe to call twice. */
  const recordPaid = async (
    session: Stripe.Checkout.Session,
    paidAt: string,
  ): Promise<'recorded' | 'duplicate' | 'ignored'> => {
    const billId = session.metadata?.billId;
    const userId = session.metadata?.userId;
    if (session.payment_status !== 'paid' || !billId || !userId) return 'ignored';
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    return deps.store.putIfAbsent({
      billId,
      userId,
      checkoutSessionId: session.id,
      ...(paymentIntentId ? { paymentIntentId } : {}),
      amountPence: session.amount_total ?? 0,
      paidAt,
    });
  };

  /**
   * The webhook hasn't landed (slow, or not reaching this API at all, as
   * locally without `stripe listen`): ask Stripe about the caller's own
   * Checkout Session and record it if it's paid for this bill.
   */
  const reconcile = async (bill: Bill, caller: VerifiedCaller, checkoutSessionId: string) => {
    let session: Stripe.Checkout.Session;
    try {
      session = await timed('stripe', 'checkout.sessions.retrieve', () =>
        deps.stripe.checkout.sessions.retrieve(checkoutSessionId),
      );
    } catch {
      return null; // unknown or foreign id: keep waiting for the webhook
    }
    if (session.metadata?.billId !== bill.billId || session.metadata?.userId !== caller.userId) {
      return null;
    }
    if ((await recordPaid(session, new Date().toISOString())) === 'ignored') return null;
    return deps.store.get(bill.billId);
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

    async status(input: {
      caller: VerifiedCaller;
      billId: string;
      /** The Checkout Session the page just confirmed, to check with Stripe directly. */
      checkoutSessionId?: string;
    }): Promise<TableFeeStatus> {
      const bill = await loadOwnBill(input.billId, input.caller);
      let fee = await deps.store.get(bill.billId);
      // A refunded fee bought nothing: sharing the bill again costs a new fee.
      if (fee?.refundedAt) fee = null;
      if (!fee && input.checkoutSessionId) {
        fee = await reconcile(bill, input.caller, input.checkoutSessionId);
        if (fee?.refundedAt) fee = null;
      }
      if (fee)
        return {
          billId: bill.billId,
          status: 'paid',
          amountPence: fee.amountPence,
          paidAt: fee.paidAt,
        };
      if (isExempt(input.caller)) return { billId: bill.billId, status: 'waived', amountPence: 0 };
      const amountPence = feeLookupKeyFor(bill.totalPence) === 'table_fee_3' ? 300 : 200;
      return { billId: bill.billId, status: 'unpaid', amountPence };
    },

    /**
     * Refunds the lead's fee when the bill closes or is binned before any
     * guest joined (the Refunds page). Safe to call twice: the fee row
     * records the refund, and Stripe's idempotency key stops a second one
     * if the row write is lost.
     */
    async refundIfNobodyJoined(session: ClosedSession): Promise<RefundOutcome> {
      if (!nobodyJoined(session)) return 'guests_joined';
      const fee = await deps.store.get(session.billId);
      if (!fee) return 'no_fee';
      if (fee.refundedAt) return 'already_refunded';
      let paymentIntentId = fee.paymentIntentId;
      if (!paymentIntentId) {
        const cs = await timed('stripe', 'checkout.sessions.retrieve', () =>
          deps.stripe.checkout.sessions.retrieve(fee.checkoutSessionId),
        );
        paymentIntentId =
          typeof cs.payment_intent === 'string' ? cs.payment_intent : cs.payment_intent?.id;
      }
      if (!paymentIntentId) return 'no_payment_intent';
      const refund = await timed('stripe', 'refunds.create', () =>
        deps.stripe.refunds.create(
          {
            payment_intent: paymentIntentId,
            reason: 'requested_by_customer',
            metadata: {
              billId: session.billId,
              sessionId: session.sessionId,
              policy: 'nobody_joined',
            },
          },
          { idempotencyKey: `table-fee-refund-${fee.checkoutSessionId}` },
        ),
      );
      const written = await deps.store.markRefunded(session.billId, {
        refundId: refund.id,
        refundedAt: new Date().toISOString(),
      });
      return written === 'recorded' ? 'refunded' : 'already_refunded';
    },

    /** Applies a verified Stripe event. Safe to receive the same event twice. */
    async handleEvent(event: Stripe.Event): Promise<'applied' | 'duplicate' | 'ignored'> {
      if (
        event.type !== 'checkout.session.completed' &&
        event.type !== 'checkout.session.async_payment_succeeded'
      ) {
        return 'ignored';
      }
      const result = await recordPaid(
        event.data.object,
        new Date(event.created * 1000).toISOString(),
      );
      if (result === 'ignored') return 'ignored';
      return result === 'recorded' ? 'applied' : 'duplicate';
    },
  };
};

export type TableFeeService = ReturnType<typeof createTableFeeService>;
