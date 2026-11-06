/**
 * The money journey's sums and checks (scripts/money-journey.ts): a real
 * bill on the deployed dev API, real Stripe test mode, and the #228 fee
 * model end to end. Pure, so they're unit tested here; the script does the
 * calls.
 *
 * The expected charge comes from the same money module the API and the web
 * app use (packages/core/src/lib/owed.ts), worked out from what the API
 * returns, not from anything the API worked out itself.
 */
import { feePence, splitsOf } from '@gdp/core/lib/owed';

/** Stripe won't charge a card less than this; the API charges nothing under it. */
export const STRIPE_MIN_PENCE = 30;

export type JourneyItem = { itemId: string; unitPricePence: number; quantity: number };
export type JourneyBill = {
  subtotalPence: number;
  serviceChargePence: number;
  taxPence: number;
  discounts?: ReadonlyArray<{ amountPence: number }> | null;
  items: readonly JourneyItem[];
};
export type JourneyParticipant = {
  userId: string;
  claimedItemIds: readonly string[];
  sharedItemIds?: readonly string[];
};
export type JourneySession = {
  creatorUserId: string;
  platformFeePence?: number;
  participants: readonly JourneyParticipant[];
};

/** What one guest who claims only `itemIds` would be charged in round-ups. */
const roundUpFor = (bill: JourneyBill, holdPence: number, itemIds: readonly string[]): number =>
  feePence(
    bill,
    { creatorUserId: '\u0000lead', platformFeePence: holdPence, participants: [] },
    { userId: 'guest', claimedItemIds: itemIds },
    [],
  );

/**
 * One line each for two guests, so both have a round-up and together they
 * reach Stripe's minimum (the charge path, not the "under 30p" one). The
 * lead takes every other line. Null when the bill has no such pair.
 */
export function pickClaims(
  bill: JourneyBill,
  holdPence: number,
): { guests: [string[], string[]]; lead: string[]; roundUps: [number, number] } | null {
  const fees = bill.items.map((i) => roundUpFor(bill, holdPence, [i.itemId]));
  let best: { a: number; b: number; sum: number } | null = null;
  for (let a = 0; a < bill.items.length; a++) {
    for (let b = a + 1; b < bill.items.length; b++) {
      const fa = fees[a]!;
      const fb = fees[b]!;
      if (fa <= 0 || fb <= 0 || fa + fb < STRIPE_MIN_PENCE) continue;
      if (!best || fa + fb > best.sum) best = { a, b, sum: fa + fb };
    }
  }
  if (!best) return null;
  const ga = bill.items[best.a]!.itemId;
  const gb = bill.items[best.b]!.itemId;
  return {
    guests: [[ga], [gb]],
    lead: bill.items.map((i) => i.itemId).filter((id) => id !== ga && id !== gb),
    roundUps: [fees[best.a]!, fees[best.b]!],
  };
}

/**
 * The round-ups the lead should be charged at settle: each received
 * guest's, from the session and bill the API returned.
 */
export function expectedCharge(
  bill: JourneyBill,
  session: JourneySession,
  receivedGuestIds: readonly string[],
): { perGuest: Record<string, number>; total: number } {
  const splits = splitsOf(session.participants);
  const perGuest: Record<string, number> = {};
  for (const p of session.participants) {
    if (p.userId === session.creatorUserId || !receivedGuestIds.includes(p.userId)) continue;
    perGuest[p.userId] = feePence(bill, session, p, splits);
  }
  const total = Object.values(perGuest).reduce((a, b) => a + b, 0);
  return { perGuest, total };
}

/** The Checkout Session's id from its client secret (`cs_…_secret_…`). */
export function checkoutSessionIdOf(clientSecret: string): string | null {
  const m = /^(cs_(?:test|live)_[A-Za-z0-9]+)_secret_/.exec(clientSecret);
  return m ? m[1]! : null;
}

/** Only ever a Stripe test-mode key: the journey makes real charges. */
export const isTestKey = (key: string): boolean => /^(sk|rk)_test_/.test(key);

export type FeeRow = {
  billId: string;
  kind?: string;
  savedCard?: true;
  releasedAt?: string;
  chargeStatus?: string;
  chargePence?: number;
};
export type IntentView = {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  payment_method: string | null;
  metadata: Record<string, string>;
};

/**
 * Everything wrong with the settled fee: the API's view of it, and Stripe's
 * hold and charge. Empty when the lead was charged exactly `expected` on
 * the card saved with the hold, and the hold was released.
 */
export function settledProblems(input: {
  expected: number;
  sessionId: string;
  fee: FeeRow | undefined;
  hold: IntentView;
  charges: readonly IntentView[];
}): string[] {
  const { expected, fee, hold, charges } = input;
  const problems: string[] = [];
  if (!fee) {
    problems.push('the API lists no fee for the bill');
  } else {
    if (fee.kind !== 'hold') problems.push(`fee kind is ${fee.kind ?? 'none'}, not hold`);
    if (!fee.savedCard) problems.push('the fee has no saved card');
    if (!fee.releasedAt) problems.push('the API says the hold was not released');
    if (fee.chargeStatus !== 'charged') {
      problems.push(`the API says the charge is ${fee.chargeStatus ?? 'missing'}, not charged`);
    }
    if (fee.chargePence !== expected) {
      problems.push(`the API charged ${fee.chargePence ?? 'nothing'}p, expected ${expected}p`);
    }
  }
  if (hold.status !== 'canceled')
    problems.push(`the hold is ${hold.status} in Stripe, not canceled`);
  if (hold.amount_received !== 0) problems.push(`${hold.amount_received}p was taken from the hold`);
  const ours = charges.filter(
    (c) => c.metadata.kind === 'roundups' && c.metadata.sessionId === input.sessionId,
  );
  if (ours.length !== 1) {
    problems.push(`Stripe has ${ours.length} round-up charges for the session, expected 1`);
    return problems;
  }
  const charge = ours[0]!;
  if (charge.status !== 'succeeded') problems.push(`the charge is ${charge.status}, not succeeded`);
  if (charge.amount_received !== expected) {
    problems.push(`Stripe received ${charge.amount_received}p, expected ${expected}p`);
  }
  if (!hold.payment_method || charge.payment_method !== hold.payment_method) {
    problems.push('the charge is not on the card saved with the hold');
  }
  return problems;
}
