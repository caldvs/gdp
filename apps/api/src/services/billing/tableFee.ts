import type Stripe from 'stripe';
import { AppError } from '../../errors/AppError.js';
import { timed } from '../../logging/timed.js';
import { baseLogger } from '../../logging/logger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Bill } from '../../types/bills.js';

/**
 * Sharing without a credit puts a £1 hold on the lead's card (decisions:
 * Pricing, #165). Nothing is taken then. Placing it saves the card (#228):
 * at settle the hold is always released and the saved card is charged the
 * guests' round-ups the lead received, with no cap. Holds from before #228
 * (no saved card) are still taken from at close, at most the hold (#167).
 */
export const HOLD_PENCE = 100;

/** Stripe's smallest GBP charge: a guests' part under it isn't taken (#167). */
export const STRIPE_MIN_PENCE = 30;

export { parseEmailList } from '../../config/exemptEmails.js';

export interface TableFee {
  billId: string;
  userId: string;
  checkoutSessionId: string;
  paymentIntentId?: string;
  /** What was paid, or for a hold what was authorised. */
  amountPence: number;
  /** When it was paid, or for a hold when it was authorised. */
  paidAt: string;
  /**
   * `hold`: a card hold (#165), taken from or released at close. Absent: a
   * fee paid outright, from before holds.
   */
  kind?: 'hold';
  /** Set once a hold was cancelled: nothing was taken. */
  releasedAt?: string;
  /** What was taken from a hold at close: the guests' part, at most the hold (#167). */
  capturedPence?: number;
  capturedAt?: string;
  /**
   * #228: the Stripe customer and the card saved with this hold, for the
   * charge at settle. Absent on holds placed before #228.
   */
  customerId?: string;
  paymentMethodId?: string;
  /**
   * #228: the charge at settle, decided once. `charged`: the round-ups were
   * taken from the saved card. `needs_confirming`: the bank wanted the lead
   * to confirm it (they're emailed a link). `none`: under 30p or nobody paid.
   */
  chargeStatus?: 'charged' | 'needs_confirming' | 'none';
  chargePence?: number;
  chargeIntentId?: string;
  chargedAt?: string;
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
  /**
   * `holdPence`: a hold the guests pay back (absent for a fee paid outright),
   * placed at `heldAt` (the daily sweep takes it before it lapses, #168).
   */
  | { kind: 'fee'; billId: string; sessionId: string; holdPence?: number; heldAt?: string }
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
  /** Marks a hold released, once. `duplicate` if it already was, or there's no fee. */
  markReleased(billId: string, releasedAt: string): Promise<'recorded' | 'duplicate'>;
  /** Records what was taken from a hold, once. `duplicate` if it already was settled. */
  markCaptured(
    billId: string,
    capture: { capturedPence: number; capturedAt: string },
  ): Promise<'recorded' | 'duplicate'>;
  /**
   * #228: records the charge at settle, once (`needs_confirming` can later
   * become `charged`). `duplicate` if it was already recorded.
   */
  markCharge(
    billId: string,
    charge: {
      chargeStatus: NonNullable<TableFee['chargeStatus']>;
      chargePence: number;
      chargeIntentId?: string;
      chargedAt?: string;
    },
  ): Promise<'recorded' | 'duplicate'>;
  /** #228: the PaymentIntent the lead confirms a `needs_confirming` charge with. */
  setChargeIntent(billId: string, chargeIntentId: string): Promise<void>;
  /** Marks the fee refunded, once. `duplicate` if it already was, or there's no fee. */
  markRefunded(
    billId: string,
    refund: { refundId: string; refundedAt: string },
  ): Promise<'recorded' | 'duplicate'>;
}

/** #228: what the confirm-the-charge page needs. */
export interface FeeCharge {
  billId: string;
  status: 'charged' | 'needs_confirming' | 'none';
  amountPence: number;
  /** The PaymentIntent's client secret, to confirm it in the page. */
  clientSecret?: string;
  /** The saved card, offered first. */
  paymentMethodId?: string;
  card?: { brand?: string; last4?: string };
}

/** #228: the lead's Stripe customer and saved card (Stripe ids and what the card shows only). */
export interface SavedCard {
  userId: string;
  customerId: string;
  /** Absent once the lead removed the card. */
  paymentMethodId?: string;
  /** `visa`, `mastercard`…; the wallet it came from, if any. */
  brand?: string;
  last4?: string;
  wallet?: string;
  savedAt?: string;
}

export interface SavedCardStore {
  get(userId: string): Promise<SavedCard | null>;
  put(card: SavedCard): Promise<void>;
}

/** What `refundIfNobodyJoined` did, for logs and tests. */
export type RefundOutcome =
  | 'refunded'
  | 'released'
  | 'credit_returned'
  | 'guests_joined'
  | 'no_fee'
  | 'already_refunded'
  | 'no_payment_intent';

/** What `takeFromHold` did, for logs and tests. */
export type CaptureOutcome =
  | 'captured'
  | 'charged'
  | 'needs_confirming'
  | 'released'
  | 'lapsed'
  | 'no_hold'
  | 'already_settled';

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
  amountPence: number;
  billId: string;
  userId: string;
  email?: string;
  /** #228: the lead's Stripe customer; the card is saved to it for the charge at settle. */
  customerId?: string;
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
  line_items: [
    {
      price_data: {
        currency: 'gbp',
        unit_amount: input.amountPence,
        product_data: { name: 'Platform fee' },
      },
      quantity: 1,
    },
  ],
  return_url: input.returnUrl,
  client_reference_id: input.userId,
  metadata: { billId: input.billId, userId: input.userId, kind: 'hold' },
  // A hold: authorised now, taken (in part) or released at close.
  payment_intent_data: {
    capture_method: 'manual',
    metadata: { billId: input.billId, userId: input.userId, kind: 'hold' },
    // #228: keep the card for one charge at settle, made while the lead is
    // away (they agree to it in the confirm before the form).
    ...(input.customerId ? { setup_future_usage: 'off_session' as const } : {}),
  },
  ...(input.customerId
    ? { customer: input.customerId }
    : input.email
      ? { customer_email: input.email }
      : {}),
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
  /** #228: the lead's saved card. Absent: holds don't save the card (the #167 flow). */
  cards?: SavedCardStore;
  /**
   * #228: tells the lead the bank wants them to confirm the charge at
   * settle, with a link to do it. Best effort: a failure is logged.
   */
  notifyNeedsConfirming?: (input: {
    userId: string;
    billId: string;
    sessionId: string;
    amountPence: number;
    confirmUrl: string;
  }) => Promise<void>;
  now?: () => Date;
}

/** How many credits the lead has this month, and when the next one comes. */
export interface CreditInfo {
  creditsLeft: 0 | 1;
  nextCreditOn: string;
}

export type TableFeeStatus =
  | { billId: string; status: 'paid'; amountPence: number; paidAt: string }
  | { billId: string; status: 'held'; amountPence: number; heldAt: string }
  | ({ billId: string; status: 'unpaid'; amountPence: number } & Partial<CreditInfo>)
  | { billId: string; status: 'waived'; amountPence: 0 }
  | ({ billId: string; status: 'free'; amountPence: 0 } & CreditInfo);

/** The lead's account: credits this month and the fees they've paid. */
export interface BillingSummary extends CreditInfo {
  /** #228: the card saved with the lead's last hold, if they kept it. */
  card?: { brand?: string; last4?: string; wallet?: string };
  paidPence: number;
  refundedPence: number;
  fees: Array<{
    billId: string;
    sessionId?: string;
    amountPence: number;
    paidAt: string;
    /** `hold`: authorised, taken at close (`capturedPence`) or released. */
    kind?: 'hold';
    releasedAt?: string;
    capturedPence?: number;
    capturedAt?: string;
    /** #228: this hold saved the card, so settle charges it the round-ups, no cap. */
    savedCard?: true;
    /** #228: the charge at settle on the saved card. */
    chargeStatus?: 'charged' | 'needs_confirming' | 'none';
    chargePence?: number;
    chargedAt?: string;
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

/** A fee that still buys a share: paid or held, not refunded or released, and not spent on another session. */
const usableFor = (fee: TableFee | null, sessionId: string | undefined): TableFee | null => {
  if (!fee || fee.refundedAt || fee.releasedAt) return null;
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

  /** #228: the lead's Stripe customer, made once and kept on their `CARD#` row. */
  const ensureCustomer = async (caller: VerifiedCaller): Promise<string | undefined> => {
    if (!deps.cards) return undefined;
    const card = await deps.cards.get(caller.userId);
    if (card?.customerId) return card.customerId;
    const customer = await timed('stripe', 'customers.create', () =>
      deps.stripe.customers.create(
        {
          ...(caller.email ? { email: caller.email } : {}),
          metadata: { userId: caller.userId },
        },
        { idempotencyKey: `customer-${caller.userId}` },
      ),
    );
    await deps.cards.put({ userId: caller.userId, customerId: customer.id });
    return customer.id;
  };

  /** A bill that can take a new hold: the caller's, no usable hold, not exempt. */
  const holdableBill = async (caller: VerifiedCaller, billId: string): Promise<Bill> => {
    const bill = await loadOwnBill(billId, caller);
    // A fee spent on an earlier share doesn't stop a new one.
    const existing = usableFor(await deps.store.get(bill.billId), undefined);
    if (existing) {
      throw new AppError('TABLE_FEE_PAID', 'This bill already has a hold');
    }
    if (isExempt(caller)) {
      throw new AppError('TABLE_FEE_WAIVED', 'No fee is due: this account is exempt');
    }
    return bill;
  };

  const startCheckoutUnsafe = async (input: { caller: VerifiedCaller; billId: string }) => {
    const bill = await holdableBill(input.caller, input.billId);
    const customerId = await ensureCustomer(input.caller);
    const returnUrl = `${deps.appBaseUrl}/table-fee/${bill.billId}?session_id={CHECKOUT_SESSION_ID}`;
    const session = await timed('stripe', 'checkout.sessions.create', () =>
      deps.stripe.checkout.sessions.create(
        checkoutSessionParams({
          amountPence: HOLD_PENCE,
          billId: bill.billId,
          userId: input.caller.userId,
          ...(input.caller.email ? { email: input.caller.email } : {}),
          ...(customerId ? { customerId } : {}),
          returnUrl,
        }),
      ),
    );
    if (!session.client_secret) {
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Stripe returned no client secret');
    }
    return { clientSecret: session.client_secret, amountPence: HOLD_PENCE };
  };

  /**
   * Records an authorised hold (#165): from a Checkout Session, or placed on
   * the saved card (#228, keyed by its PaymentIntent). A hold made to save
   * the card (`setup_future_usage`) keeps the customer and card on the row
   * and on the lead's `CARD#` row, for the charge at settle.
   */
  const recordHold = async (
    intent: Stripe.PaymentIntent,
    at: { billId: string; userId: string; checkoutSessionId: string; paidAt: string },
  ): Promise<'recorded' | 'duplicate' | 'ignored'> => {
    if (intent.status !== 'requires_capture') return 'ignored';
    const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
    const paymentMethodId =
      typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
    const saved =
      !!deps.cards &&
      !!customerId &&
      !!paymentMethodId &&
      (intent.setup_future_usage === 'off_session' || intent.metadata?.savedCard === 'true');
    const written = await deps.store.putIfAbsent({
      billId: at.billId,
      userId: at.userId,
      checkoutSessionId: at.checkoutSessionId,
      paymentIntentId: intent.id,
      kind: 'hold',
      amountPence: intent.amount_capturable,
      paidAt: at.paidAt,
      ...(saved ? { customerId, paymentMethodId } : {}),
    });
    if (saved && written === 'recorded') await rememberCard(at.userId, customerId, paymentMethodId);
    return written;
  };

  /** Keeps what the card shows (brand, last four) on the lead's `CARD#` row. Never fails the hold. */
  const rememberCard = async (userId: string, customerId: string, paymentMethodId: string) => {
    try {
      const pm = await timed('stripe', 'paymentMethods.retrieve', () =>
        deps.stripe.paymentMethods.retrieve(paymentMethodId),
      );
      await deps.cards!.put({
        userId,
        customerId,
        paymentMethodId,
        ...(pm.card?.brand ? { brand: pm.card.brand } : {}),
        ...(pm.card?.last4 ? { last4: pm.card.last4 } : {}),
        ...(pm.card?.wallet?.type ? { wallet: pm.card.wallet.type } : {}),
        savedAt: now().toISOString(),
      });
    } catch (err) {
      baseLogger.warn(
        { event: 'table_fee.card_not_saved', userId, err },
        'Saved card not recorded',
      );
    }
  };

  /**
   * #228: a hold placed on the saved card. The webhook may not cover it, so
   * the page's poll asks Stripe about its own PaymentIntent.
   */
  const reconcileIntent = async (bill: Bill, caller: VerifiedCaller, paymentIntentId: string) => {
    let intent: Stripe.PaymentIntent;
    try {
      intent = await timed('stripe', 'paymentIntents.retrieve', () =>
        deps.stripe.paymentIntents.retrieve(paymentIntentId),
      );
    } catch {
      return null;
    }
    if (
      intent.metadata?.kind !== 'hold' ||
      intent.metadata?.billId !== bill.billId ||
      intent.metadata?.userId !== caller.userId
    ) {
      return null;
    }
    const written = await recordHold(intent, {
      billId: bill.billId,
      userId: caller.userId,
      checkoutSessionId: intent.id,
      paidAt: now().toISOString(),
    });
    return written === 'ignored' ? null : deps.store.get(bill.billId);
  };

  /**
   * Records a completed Checkout Session for its bill: an authorised hold,
   * or (from before holds) a paid fee. Safe to call twice.
   */
  const recordPaid = async (
    session: Stripe.Checkout.Session,
    paidAt: string,
  ): Promise<'recorded' | 'duplicate' | 'ignored'> => {
    const billId = session.metadata?.billId;
    const userId = session.metadata?.userId;
    if (!userId || !billId) return 'ignored';
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (session.metadata?.kind === 'hold') {
      // A hold's Checkout Session completes unpaid: the PaymentIntent says
      // whether the card was authorised.
      if (session.status !== 'complete' || !paymentIntentId) return 'ignored';
      const intent = await timed('stripe', 'paymentIntents.retrieve', () =>
        deps.stripe.paymentIntents.retrieve(paymentIntentId),
      );
      return recordHold(intent, { billId, userId, checkoutSessionId: session.id, paidAt });
    }
    if (session.payment_status !== 'paid') return 'ignored';
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
    paymentIntentId?: string;
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
    if (!fee && input.paymentIntentId) {
      fee = usableFor(
        await reconcileIntent(bill, input.caller, input.paymentIntentId),
        input.sessionId,
      );
    }
    if (fee) {
      return {
        month,
        status:
          fee.kind === 'hold'
            ? {
                billId: bill.billId,
                status: 'held',
                amountPence: fee.amountPence,
                heldAt: fee.paidAt,
              }
            : {
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
    const amountPence = HOLD_PENCE;
    if (!deps.credits) {
      return { month, status: { billId: bill.billId, status: 'unpaid', amountPence } };
    }
    const credit = await deps.credits.get(input.caller.userId, month);
    const next = nextCreditOn(month);
    const free =
      !credit || !!credit.returnedAt || (!!input.sessionId && credit.sessionId === input.sessionId);
    // The month's free credit first, then the hold.
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

  /** Cancels a hold: nothing is taken. Safe to call twice. */
  const releaseHold = async (fee: TableFee): Promise<RefundOutcome> => {
    if (!fee.paymentIntentId) return 'no_payment_intent';
    try {
      await timed('stripe', 'paymentIntents.cancel', () =>
        deps.stripe.paymentIntents.cancel(
          fee.paymentIntentId!,
          { cancellation_reason: 'abandoned' },
          { idempotencyKey: `table-fee-release-${fee.checkoutSessionId}` },
        ),
      );
    } catch (err) {
      // Already cancelled (or lapsed): nothing was taken either way.
      const e = err as { code?: string };
      if (e.code !== 'payment_intent_unexpected_state') throw err;
    }
    const written = await deps.store.markReleased(fee.billId, now().toISOString());
    return written === 'recorded' ? 'released' : 'already_refunded';
  };

  /** Turns a Stripe error into a plain message for the client; Stripe's own goes to the logs (#155). */
  const providerError = (err: unknown, message: string): never => {
    if (err instanceof AppError) throw err;
    const e = err as { type?: string; message?: string };
    if (e.type?.startsWith('Stripe')) {
      baseLogger.error({ event: 'table_fee.stripe_error', type: e.type, err }, e.message);
      throw new AppError('PAYMENT_PROVIDER_ERROR', message);
    }
    throw err;
  };

  /**
   * #228: the charge at settle. Charges the saved card `amount` (the
   * round-ups, no cap) while the lead is away, once per session (the
   * idempotency key), and records it. The bank asking the lead to confirm
   * (or declining) leaves it `needs_confirming` and emails them a link.
   * Under Stripe's 30p minimum: nothing is charged (`none`).
   */
  const chargeSavedCard = async (
    fee: TableFee,
    session: ClosedSession,
    amount: number,
  ): Promise<'charged' | 'needs_confirming' | 'none'> => {
    if (amount < STRIPE_MIN_PENCE) {
      await deps.store.markCharge(fee.billId, {
        chargeStatus: 'none',
        chargePence: 0,
        chargedAt: now().toISOString(),
      });
      return 'none';
    }
    let intent: Stripe.PaymentIntent;
    try {
      intent = await timed('stripe', 'paymentIntents.create', () =>
        deps.stripe.paymentIntents.create(
          {
            amount,
            currency: 'gbp',
            customer: fee.customerId!,
            payment_method: fee.paymentMethodId!,
            off_session: true,
            confirm: true,
            description: 'Platform fee: your guests’ round-ups',
            metadata: {
              billId: fee.billId,
              userId: fee.userId,
              sessionId: session.sessionId,
              kind: 'roundups',
            },
          },
          { idempotencyKey: `table-fee-charge-${session.sessionId}` },
        ),
      );
    } catch (err) {
      const e = err as { type?: string; code?: string; payment_intent?: { id?: string } };
      // A card the bank won't charge with the lead away (3D Secure, a
      // decline, an expired card): they confirm it themselves.
      if (e.type !== 'StripeCardError') throw err;
      baseLogger.info(
        { event: 'table_fee.charge_needs_confirming', billId: fee.billId, code: e.code },
        'Round-ups charge needs the lead',
      );
      return needsConfirming(fee, session, amount, e.payment_intent?.id);
    }
    if (intent.status === 'succeeded') {
      await deps.store.markCharge(fee.billId, {
        chargeStatus: 'charged',
        chargePence: intent.amount_received || amount,
        chargeIntentId: intent.id,
        chargedAt: now().toISOString(),
      });
      return 'charged';
    }
    return needsConfirming(fee, session, amount, intent.id);
  };

  const needsConfirming = async (
    fee: TableFee,
    session: ClosedSession,
    amount: number,
    intentId: string | undefined,
  ): Promise<'needs_confirming'> => {
    const written = await deps.store.markCharge(fee.billId, {
      chargeStatus: 'needs_confirming',
      chargePence: amount,
      ...(intentId ? { chargeIntentId: intentId } : {}),
    });
    if (written === 'recorded' && deps.notifyNeedsConfirming) {
      try {
        await deps.notifyNeedsConfirming({
          userId: fee.userId,
          billId: fee.billId,
          sessionId: session.sessionId,
          amountPence: amount,
          confirmUrl: `${deps.appBaseUrl}/fee-charge/${fee.billId}`,
        });
      } catch (err) {
        baseLogger.error(
          { event: 'table_fee.confirm_email_failed', billId: fee.billId, err },
          'Couldn’t email the lead to confirm the charge',
        );
      }
    }
    return 'needs_confirming';
  };

  return {
    /** Starts the embedded checkout for this bill's fee and returns the form's client secret. */
    async startCheckout(input: { caller: VerifiedCaller; billId: string }) {
      try {
        return await startCheckoutUnsafe(input);
      } catch (err) {
        // A Stripe error (bad key, test/live mix-up, a parameter this
        // account doesn't support): a plain message for the client.
        return providerError(err, 'Couldn’t start the payment. Try again.');
      }
    },

    /**
     * #228: the £1 hold on the card saved with the lead's last hold, in one
     * tap. `held` when the bank said yes; `requires_action` when it wants
     * the lead to confirm (3D Secure): the page finishes it with Stripe.js
     * and polls with the PaymentIntent.
     */
    async holdOnSavedCard(input: {
      caller: VerifiedCaller;
      billId: string;
    }): Promise<
      | { status: 'held'; amountPence: number }
      | { status: 'requires_action'; clientSecret: string; paymentIntentId: string }
    > {
      const bill = await holdableBill(input.caller, input.billId);
      const card = deps.cards ? await deps.cards.get(input.caller.userId) : null;
      if (!card?.paymentMethodId) {
        throw new AppError('NOT_FOUND', 'No saved card');
      }
      let intent: Stripe.PaymentIntent;
      try {
        intent = await timed('stripe', 'paymentIntents.create', () =>
          deps.stripe.paymentIntents.create({
            amount: HOLD_PENCE,
            currency: 'gbp',
            customer: card.customerId,
            payment_method: card.paymentMethodId!,
            capture_method: 'manual',
            confirm: true,
            // The lead is here: Stripe.js finishes any 3D Secure in the page.
            use_stripe_sdk: true,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            description: 'Platform fee hold',
            metadata: {
              billId: bill.billId,
              userId: input.caller.userId,
              kind: 'hold',
              savedCard: 'true',
            },
          }),
        );
      } catch (err) {
        const e = err as { type?: string };
        if (e.type === 'StripeCardError') {
          throw new AppError(
            'PAYMENT_PROVIDER_ERROR',
            'Your card didn’t go through. Use another card.',
          );
        }
        return providerError(err, 'Couldn’t start the payment. Try again.');
      }
      if (intent.status === 'requires_capture') {
        await recordHold(intent, {
          billId: bill.billId,
          userId: input.caller.userId,
          checkoutSessionId: intent.id,
          paidAt: now().toISOString(),
        });
        return { status: 'held', amountPence: HOLD_PENCE };
      }
      if (intent.status === 'requires_action' && intent.client_secret) {
        return {
          status: 'requires_action',
          clientSecret: intent.client_secret,
          paymentIntentId: intent.id,
        };
      }
      throw new AppError(
        'PAYMENT_PROVIDER_ERROR',
        'Your card didn’t go through. Use another card.',
      );
    },

    /**
     * #228: the charge the bank wanted the lead to confirm. Returns what the
     * confirm page needs (the PaymentIntent's client secret and the saved
     * card), or that it's done. Asks Stripe, so a charge confirmed a moment
     * ago shows as charged even before its webhook.
     */
    async feeCharge(input: { caller: VerifiedCaller; billId: string }): Promise<FeeCharge> {
      const fee = await deps.store.get(input.billId);
      if (!fee || fee.userId !== input.caller.userId || !fee.chargeStatus) {
        throw new AppError('NOT_FOUND', 'No charge for this bill');
      }
      const amountPence = fee.chargePence ?? 0;
      if (fee.chargeStatus !== 'needs_confirming') {
        return { billId: fee.billId, status: fee.chargeStatus, amountPence };
      }
      let intent: Stripe.PaymentIntent | null = null;
      if (fee.chargeIntentId) {
        intent = await timed('stripe', 'paymentIntents.retrieve', () =>
          deps.stripe.paymentIntents.retrieve(fee.chargeIntentId!),
        );
      }
      if (intent?.status === 'succeeded') {
        await deps.store.markCharge(fee.billId, {
          chargeStatus: 'charged',
          chargePence: intent.amount_received || amountPence,
          chargeIntentId: intent.id,
          chargedAt: now().toISOString(),
        });
        return { billId: fee.billId, status: 'charged', amountPence };
      }
      if (!intent || intent.status === 'canceled') {
        // The off-session try left no PaymentIntent we can use: make one
        // for the lead to confirm here.
        intent = await timed('stripe', 'paymentIntents.create', () =>
          deps.stripe.paymentIntents.create(
            {
              amount: amountPence,
              currency: 'gbp',
              ...(fee.customerId ? { customer: fee.customerId } : {}),
              automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
              description: 'Platform fee: your guests’ round-ups',
              metadata: {
                billId: fee.billId,
                userId: fee.userId,
                ...(fee.sessionId ? { sessionId: fee.sessionId } : {}),
                kind: 'roundups',
              },
            },
            { idempotencyKey: `table-fee-charge-confirm-${fee.billId}` },
          ),
        );
        await deps.store.setChargeIntent(fee.billId, intent.id);
      }
      const card = deps.cards ? await deps.cards.get(fee.userId) : null;
      return {
        billId: fee.billId,
        status: 'needs_confirming',
        amountPence,
        ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
        ...(card?.paymentMethodId && card.paymentMethodId === fee.paymentMethodId
          ? {
              paymentMethodId: card.paymentMethodId,
              card: {
                ...(card.brand ? { brand: card.brand } : {}),
                ...(card.last4 ? { last4: card.last4 } : {}),
              },
            }
          : {}),
      };
    },

    /** #228: *Remove* on Account: detaches the saved card from the lead's customer. */
    async removeCard(caller: VerifiedCaller): Promise<void> {
      const card = deps.cards ? await deps.cards.get(caller.userId) : null;
      if (!card?.paymentMethodId) return;
      try {
        await timed('stripe', 'paymentMethods.detach', () =>
          deps.stripe.paymentMethods.detach(card.paymentMethodId!),
        );
      } catch (err) {
        // Already detached in Stripe: forget it here too.
        const e = err as { type?: string };
        if (e.type !== 'StripeInvalidRequestError') {
          return providerError(err, 'Couldn’t remove the card. Try again.');
        }
      }
      await deps.cards!.put({ userId: card.userId, customerId: card.customerId });
    },

    async status(input: {
      caller: VerifiedCaller;
      billId: string;
      /** The Checkout Session the page just confirmed, to check with Stripe directly. */
      checkoutSessionId?: string;
      /** #228: the saved-card hold the page just confirmed. */
      paymentIntentId?: string;
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
      if (status.status === 'held') {
        return {
          kind: 'fee',
          billId: input.billId,
          sessionId: input.sessionId,
          holdPence: status.amountPence,
          heldAt: status.heldAt,
        };
      }
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
      const card = deps.cards ? await deps.cards.get(caller.userId) : null;
      const fees = history.fees.map((f) => ({
        billId: f.billId,
        ...(f.sessionId ? { sessionId: f.sessionId } : {}),
        amountPence: f.amountPence,
        paidAt: f.paidAt,
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.releasedAt ? { releasedAt: f.releasedAt } : {}),
        ...(f.capturedAt ? { capturedPence: f.capturedPence ?? 0, capturedAt: f.capturedAt } : {}),
        ...(f.paymentMethodId && f.customerId ? { savedCard: true as const } : {}),
        ...(f.chargeStatus
          ? {
              chargeStatus: f.chargeStatus,
              chargePence: f.chargePence ?? 0,
              ...(f.chargedAt ? { chargedAt: f.chargedAt } : {}),
            }
          : {}),
        ...(f.refundedAt ? { refundedAt: f.refundedAt } : {}),
      }));
      return {
        ...(card?.paymentMethodId
          ? {
              card: {
                ...(card.brand ? { brand: card.brand } : {}),
                ...(card.last4 ? { last4: card.last4 } : {}),
                ...(card.wallet ? { wallet: card.wallet } : {}),
              },
            }
          : {}),
        creditsLeft: deps.credits && (!current || current.returnedAt) ? 1 : 0,
        nextCreditOn: nextCreditOn(month),
        // A hold is only paid for what was taken from it at close (#167),
        // or charged to the saved card at settle (#228).
        paidPence: fees.reduce(
          (acc, f) =>
            acc +
            (f.kind === 'hold'
              ? (f.capturedPence ?? 0) + (f.chargeStatus === 'charged' ? (f.chargePence ?? 0) : 0)
              : f.amountPence),
          0,
        ),
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
      if (fee.refundedAt || fee.releasedAt || fee.capturedAt) return 'already_refunded';
      if (fee.kind === 'hold') return releaseHold(fee);
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

    /**
     * At close, with guests at the table (#167): takes what they owe of the
     * platform fee from the hold that shared this session, at most the hold,
     * and releases the rest. Under Stripe's 30p minimum (or when the lead
     * binned the bill: pass 0) the hold is cancelled instead. Safe to call
     * twice: the row records it, and Stripe's idempotency key stops a
     * second capture if the row write is lost.
     */
    async takeFromHold(session: ClosedSession, guestsFeePence: number): Promise<CaptureOutcome> {
      const fee = await deps.store.get(session.billId);
      if (!fee || fee.kind !== 'hold' || fee.sessionId !== session.sessionId) return 'no_hold';
      if (fee.paymentMethodId && fee.customerId) {
        // #228: charge the saved card the round-ups (no cap), then release
        // the hold. Each step happens once; a retry (the next close, or the
        // daily sweep) finishes whichever didn't.
        if (fee.refundedAt || fee.capturedAt) return 'already_settled';
        let charged: 'charged' | 'needs_confirming' | 'none' | null = null;
        if (!fee.chargeStatus) {
          charged = await chargeSavedCard(fee, session, Math.max(0, guestsFeePence));
        }
        const released = fee.releasedAt ? 'already_refunded' : await releaseHold(fee);
        if (charged === 'charged' || charged === 'needs_confirming') return charged;
        if (charged === 'none' || released === 'released') return 'released';
        return 'already_settled';
      }
      if (fee.capturedAt || fee.releasedAt || fee.refundedAt) return 'already_settled';
      if (!fee.paymentIntentId) return 'no_hold';
      const amount = Math.min(Math.max(0, guestsFeePence), fee.amountPence);
      if (amount < STRIPE_MIN_PENCE) {
        const released = await releaseHold(fee);
        return released === 'released' ? 'released' : 'already_settled';
      }
      try {
        await timed('stripe', 'paymentIntents.capture', () =>
          deps.stripe.paymentIntents.capture(
            fee.paymentIntentId!,
            { amount_to_capture: amount },
            { idempotencyKey: `table-fee-capture-${fee.checkoutSessionId}` },
          ),
        );
      } catch (err) {
        const e = err as { code?: string };
        if (e.code !== 'payment_intent_unexpected_state') throw err;
        // Already captured (a lost row write), or the hold lapsed or was cancelled.
        const intent = await timed('stripe', 'paymentIntents.retrieve', () =>
          deps.stripe.paymentIntents.retrieve(fee.paymentIntentId!),
        );
        if (intent.status !== 'succeeded') {
          await deps.store.markReleased(fee.billId, now().toISOString());
          return 'lapsed';
        }
        const written = await deps.store.markCaptured(fee.billId, {
          capturedPence: intent.amount_received,
          capturedAt: now().toISOString(),
        });
        return written === 'recorded' ? 'captured' : 'already_settled';
      }
      const written = await deps.store.markCaptured(fee.billId, {
        capturedPence: amount,
        capturedAt: now().toISOString(),
      });
      return written === 'recorded' ? 'captured' : 'already_settled';
    },

    /** #228: cancels a saved-card hold before it lapses (the daily sweep); the charge waits for settle. */
    releaseBeforeLapse: releaseHold,

    /** Applies a verified Stripe event. Safe to receive the same event twice. */
    async handleEvent(event: Stripe.Event): Promise<'applied' | 'duplicate' | 'ignored'> {
      if (event.type === 'payment_intent.succeeded') {
        // #228: a round-ups charge the lead confirmed on the page.
        const intent = event.data.object;
        if (intent.metadata?.kind !== 'roundups' || !intent.metadata.billId) return 'ignored';
        const fee = await deps.store.get(intent.metadata.billId);
        if (!fee || fee.chargeStatus !== 'needs_confirming') return 'duplicate';
        const written = await deps.store.markCharge(fee.billId, {
          chargeStatus: 'charged',
          chargePence: intent.amount_received,
          chargeIntentId: intent.id,
          chargedAt: new Date(event.created * 1000).toISOString(),
        });
        return written === 'recorded' ? 'applied' : 'duplicate';
      }
      if (event.type === 'payment_intent.amount_capturable_updated') {
        // #228: a hold on the saved card (no Checkout Session).
        const intent = event.data.object;
        const { billId, userId, kind, savedCard } = intent.metadata ?? {};
        if (kind !== 'hold' || savedCard !== 'true' || !billId || !userId) return 'ignored';
        const written = await recordHold(intent, {
          billId,
          userId,
          checkoutSessionId: intent.id,
          paidAt: new Date(event.created * 1000).toISOString(),
        });
        if (written === 'ignored') return 'ignored';
        return written === 'recorded' ? 'applied' : 'duplicate';
      }
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
