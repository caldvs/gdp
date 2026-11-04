import type Stripe from 'stripe';
import { AppError } from '../../errors/AppError.js';
import { timed } from '../../logging/timed.js';
import { baseLogger } from '../../logging/logger.js';
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
  /**
   * The session this fee shared, written in the same transaction as the
   * share. One fee, one share: a fee holding another session buys nothing.
   */
  sessionId?: string;
}

/**
 * The lead's free bill for a calendar month (UK time), claimed by sharing.
 * One row per lead per month: `CREDIT#<userId>#<yyyy-mm>`.
 */
export interface MonthlyCredit {
  userId: string;
  /** `yyyy-mm`, Europe/London. */
  month: string;
  billId: string;
  sessionId: string;
  claimedAt: string;
  /** Set when the session closed or was binned with nobody joined: the credit can be spent again. */
  returnedAt?: string;
}

/** Monthly credits and the lead's fee history. Absent: no free bills (every share pays). */
export interface CreditStore {
  get(userId: string, month: string): Promise<MonthlyCredit | null>;
  /** Hands the credit back, once, if `sessionId` still holds it. */
  markReturned(
    userId: string,
    month: string,
    sessionId: string,
    returnedAt: string,
  ): Promise<'recorded' | 'duplicate'>;
  /** Every fee (replaced ones too) and credit this lead has had, newest first. */
  listForUser(userId: string): Promise<{ fees: TableFee[]; credits: MonthlyCredit[] }>;
}

/** What lets a share go ahead, written in the share's own transaction. */
export type ShareEntitlement =
  | { kind: 'fee'; billId: string; sessionId: string }
  | { kind: 'credit'; credit: MonthlyCredit }
  | { kind: 'waived' };

/** The calendar month (`yyyy-mm`) of an instant, in UK time. */
export const monthOf = (at: Date): string => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return `${year}-${month}`;
};

/** The first day of the month after `month` (`yyyy-mm` to `yyyy-mm-01`): when the next credit comes. */
export const nextCreditOn = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
};

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
  | 'refunded'
  | 'credit_returned'
  | 'guests_joined'
  | 'no_fee'
  | 'already_refunded'
  | 'no_payment_intent';

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
  /** The free bill each month. Absent: every share pays. */
  credits?: CreditStore;
  now?: () => Date;
}

/** How many credits the lead has this month, and when the next one comes. */
export interface CreditInfo {
  creditsLeft: 0 | 1;
  nextCreditOn: string;
}

export type TableFeeStatus =
  | { billId: string; status: 'paid'; amountPence: number; paidAt: string }
  | ({ billId: string; status: 'unpaid'; amountPence: number } & Partial<CreditInfo>)
  | { billId: string; status: 'waived'; amountPence: 0 }
  | ({ billId: string; status: 'free'; amountPence: 0 } & CreditInfo);

/** The lead's account: credits this month and the fees they've paid. */
export interface BillingSummary extends CreditInfo {
  paidPence: number;
  refundedPence: number;
  fees: Array<{
    billId: string;
    sessionId?: string;
    amountPence: number;
    paidAt: string;
    refundedAt?: string;
  }>;
  credits: Array<{
    month: string;
    billId: string;
    sessionId: string;
    claimedAt: string;
    returnedAt?: string;
  }>;
}

/** A fee that still buys a share: paid, not refunded, and not spent on another session. */
const usableFor = (fee: TableFee | null, sessionId: string | undefined): TableFee | null => {
  if (!fee || fee.refundedAt) return null;
  if (fee.sessionId && fee.sessionId !== sessionId) return null;
  return fee;
};

export const createTableFeeService = (deps: TableFeeServiceDeps) => {
  const now = deps.now ?? (() => new Date());
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
    // A fee spent on an earlier share doesn't stop a new one.
    const existing = usableFor(await deps.store.get(bill.billId), undefined);
    if (existing) {
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

  const resolve = async (input: {
    caller: VerifiedCaller;
    billId: string;
    checkoutSessionId?: string;
    sessionId?: string;
  }): Promise<{ status: TableFeeStatus; month: string }> => {
    const bill = await loadOwnBill(input.billId, input.caller);
    const month = monthOf(now());
    // A refunded fee bought nothing, and a fee spent on another session
    // can't share this one: either way, sharing costs a new fee.
    let fee = usableFor(await deps.store.get(bill.billId), input.sessionId);
    if (!fee && input.checkoutSessionId) {
      fee = usableFor(
        await reconcile(bill, input.caller, input.checkoutSessionId),
        input.sessionId,
      );
    }
    if (fee) {
      return {
        month,
        status: {
          billId: bill.billId,
          status: 'paid',
          amountPence: fee.amountPence,
          paidAt: fee.paidAt,
        },
      };
    }
    if (isExempt(input.caller)) {
      return { month, status: { billId: bill.billId, status: 'waived', amountPence: 0 } };
    }
    const amountPence = feeLookupKeyFor(bill.totalPence) === 'table_fee_3' ? 300 : 200;
    if (!deps.credits) {
      return { month, status: { billId: bill.billId, status: 'unpaid', amountPence } };
    }
    const credit = await deps.credits.get(input.caller.userId, month);
    const next = nextCreditOn(month);
    const free =
      !credit || !!credit.returnedAt || (!!input.sessionId && credit.sessionId === input.sessionId);
    return {
      month,
      status: free
        ? {
            billId: bill.billId,
            status: 'free',
            amountPence: 0,
            creditsLeft: 1,
            nextCreditOn: next,
          }
        : {
            billId: bill.billId,
            status: 'unpaid',
            amountPence,
            creditsLeft: 0,
            nextCreditOn: next,
          },
    };
  };

  return {
    /** Starts the embedded checkout for this bill's fee and returns the form's client secret. */
    async startCheckout(input: { caller: VerifiedCaller; billId: string }) {
      try {
        return await startCheckoutUnsafe(input);
      } catch (err) {
        if (err instanceof AppError) throw err;
        // A Stripe error (bad key, test/live mix-up, missing price, a
        // parameter this account doesn't support): a plain message for the
        // client, Stripe's own in the logs only (#155).
        const e = err as { type?: string; message?: string };
        if (e.type?.startsWith('Stripe')) {
          baseLogger.error({ event: 'table_fee.stripe_error', type: e.type, err }, e.message);
          throw new AppError('PAYMENT_PROVIDER_ERROR', 'Couldn’t start the payment. Try again.');
        }
        throw err;
      }
    },

    async status(input: {
      caller: VerifiedCaller;
      billId: string;
      /** The Checkout Session the page just confirmed, to check with Stripe directly. */
      checkoutSessionId?: string;
      /** The session being shared: a fee or credit already spent on it still counts. */
      sessionId?: string;
    }): Promise<TableFeeStatus> {
      return (await resolve(input)).status;
    },

    /**
     * What lets this session be shared: the bill's paid fee, an exempt
     * lead, or this month's credit, in that order. Throws
     * `TABLE_FEE_REQUIRED` (402) when there's none. The caller writes the
     * entitlement in the share's own transaction (one fee, one share).
     */
    async shareEntitlement(input: {
      caller: VerifiedCaller;
      billId: string;
      sessionId: string;
      checkoutSessionId?: string;
    }): Promise<ShareEntitlement> {
      const { status, month } = await resolve(input);
      if (status.status === 'paid') {
        return { kind: 'fee', billId: input.billId, sessionId: input.sessionId };
      }
      if (status.status === 'waived') return { kind: 'waived' };
      if (status.status === 'free') {
        return {
          kind: 'credit',
          credit: {
            userId: input.caller.userId,
            month,
            billId: input.billId,
            sessionId: input.sessionId,
            claimedAt: now().toISOString(),
          },
        };
      }
      throw new AppError('TABLE_FEE_REQUIRED', 'Pay the platform fee to share this bill', {
        amountPence: status.amountPence,
      });
    },

    /** The lead's credits this month and every fee they've paid. */
    async summary(caller: VerifiedCaller): Promise<BillingSummary> {
      const month = monthOf(now());
      const history = deps.credits
        ? await deps.credits.listForUser(caller.userId)
        : { fees: [], credits: [] };
      const current = history.credits.find((c) => c.month === month);
      const fees = history.fees.map((f) => ({
        billId: f.billId,
        ...(f.sessionId ? { sessionId: f.sessionId } : {}),
        amountPence: f.amountPence,
        paidAt: f.paidAt,
        ...(f.refundedAt ? { refundedAt: f.refundedAt } : {}),
      }));
      return {
        creditsLeft: deps.credits && (!current || current.returnedAt) ? 1 : 0,
        nextCreditOn: nextCreditOn(month),
        paidPence: fees.reduce((acc, f) => acc + f.amountPence, 0),
        refundedPence: fees.reduce((acc, f) => acc + (f.refundedAt ? f.amountPence : 0), 0),
        fees,
        credits: history.credits.map((c) => ({
          month: c.month,
          billId: c.billId,
          sessionId: c.sessionId,
          claimedAt: c.claimedAt,
          ...(c.returnedAt ? { returnedAt: c.returnedAt } : {}),
        })),
      };
    },

    /**
     * Refunds the lead's fee when the bill closes or is binned before any
     * guest joined (the Refunds page). Safe to call twice: the fee row
     * records the refund, and Stripe's idempotency key stops a second one
     * if the row write is lost.
     */
    async refundIfNobodyJoined(session: ClosedSession): Promise<RefundOutcome> {
      if (!nobodyJoined(session)) return 'guests_joined';
      // A credit spent on this session comes back too (this month's only:
      // last month's is gone either way).
      let creditReturned = false;
      if (deps.credits) {
        const month = monthOf(now());
        const credit = await deps.credits.get(session.creatorUserId, month);
        if (credit && credit.sessionId === session.sessionId && !credit.returnedAt) {
          creditReturned =
            (await deps.credits.markReturned(
              session.creatorUserId,
              month,
              session.sessionId,
              now().toISOString(),
            )) === 'recorded';
        }
      }
      const fee = await deps.store.get(session.billId);
      // Only the fee that paid for this session: one spent on an earlier
      // share of the same bill (which people joined) stays paid.
      if (!fee || (fee.sessionId && fee.sessionId !== session.sessionId)) {
        return creditReturned ? 'credit_returned' : 'no_fee';
      }
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
        refundedAt: now().toISOString(),
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
