import { describe, expect, it } from 'vitest';
import {
  checkoutSessionIdOf,
  expectedCharge,
  isTestKey,
  keyFromSecret,
  pickClaims,
  settledProblems,
  type IntentView,
  type JourneyBill,
} from './moneyJourney.js';

const bill = (prices: number[], service = 0): JourneyBill => ({
  subtotalPence: prices.reduce((a, b) => a + b, 0),
  serviceChargePence: service,
  taxPence: 0,
  items: prices.map((p, i) => ({ itemId: `i${i}`, unitPricePence: p, quantity: 1 })),
});

describe('pickClaims', () => {
  it('gives each guest a line with a round-up, together at least 30p, the biggest pair', () => {
    // round-ups: 280→20, 360→40, 265→35, 500→0
    const picked = pickClaims(bill([280, 360, 265, 500]), 100);
    expect(picked).toEqual({ guests: [['i1'], ['i2']], lead: ['i0', 'i3'], roundUps: [40, 35] });
  });

  it('counts service in what a guest owes', () => {
    // 10% service: 900 → 990 (10p), 450 → 495 (5p); 200 → 220 (80p)
    const picked = pickClaims(bill([900, 450, 200], 90 + 45 + 20), 100);
    expect(picked?.roundUps).toEqual([10, 80]);
  });

  it('none when no pair reaches Stripe’s minimum, or there’s no hold', () => {
    expect(pickClaims(bill([290, 295, 500]), 100)).toBeNull();
    expect(pickClaims(bill([280, 360]), 0)).toBeNull();
  });
});

describe('expectedCharge', () => {
  const b = bill([280, 360, 265]);
  const session = {
    creatorUserId: 'lead',
    platformFeePence: 100,
    participants: [
      { userId: 'lead', claimedItemIds: ['i0'] },
      { userId: 'g1', claimedItemIds: ['i1'] },
      { userId: 'g2', claimedItemIds: ['i2'] },
    ],
  };

  it('adds up the received guests’ round-ups; the lead pays none', () => {
    expect(expectedCharge(b, session, ['g1', 'g2', 'lead'])).toEqual({
      perGuest: { g1: 40, g2: 35 },
      total: 75,
    });
  });

  it('leaves out a guest who wasn’t received', () => {
    expect(expectedCharge(b, session, ['g1']).total).toBe(40);
  });

  it('splits shared lines the way the app does', () => {
    const shared = {
      ...session,
      participants: [
        { userId: 'lead', claimedItemIds: [] },
        { userId: 'g1', claimedItemIds: [], sharedItemIds: ['i1'] },
        { userId: 'g2', claimedItemIds: [], sharedItemIds: ['i1'] },
      ],
    };
    // 360 / 2 = 180 each → 20p each
    expect(expectedCharge(b, shared, ['g1', 'g2']).total).toBe(40);
  });

  it('nothing on a bill shared without a hold', () => {
    const { platformFeePence: _, ...free } = session;
    expect(expectedCharge(b, free, ['g1', 'g2']).total).toBe(0);
  });
});

describe('checkoutSessionIdOf and isTestKey', () => {
  it('reads the Checkout Session id from its client secret', () => {
    expect(checkoutSessionIdOf('cs_test_a1B2c3_secret_xyz')).toBe('cs_test_a1B2c3');
    expect(checkoutSessionIdOf('pi_123_secret_x')).toBeNull();
  });

  it('reads the key from its secret, plain or a one-entry JSON object', () => {
    expect(keyFromSecret(' sk_test_a \n')).toBe('sk_test_a');
    expect(keyFromSecret('{"STRIPE_SECRET_KEY":" sk_test_b "}')).toBe('sk_test_b');
    expect(keyFromSecret('{"a":"x","b":"y"}')).toBe('{"a":"x","b":"y"}');
    expect(keyFromSecret('{not json')).toBe('{not json');
  });

  it('takes only test-mode keys', () => {
    expect(isTestKey('sk_test_abc')).toBe(true);
    expect(isTestKey('rk_test_abc')).toBe(true);
    expect(isTestKey('sk_live_abc')).toBe(false);
    expect(isTestKey('')).toBe(false);
  });
});

describe('settledProblems', () => {
  const hold: IntentView = {
    id: 'pi_hold',
    status: 'canceled',
    amount: 100,
    amount_received: 0,
    payment_method: 'pm_1',
    metadata: { kind: 'hold' },
  };
  const charge: IntentView = {
    id: 'pi_charge',
    status: 'succeeded',
    amount: 75,
    amount_received: 75,
    payment_method: 'pm_1',
    metadata: { kind: 'roundups', sessionId: 's1' },
  };
  const fee = {
    billId: 'b1',
    kind: 'hold',
    savedCard: true as const,
    releasedAt: '2026-11-09T10:00:00Z',
    chargeStatus: 'charged',
    chargePence: 75,
  };
  const ok = { expected: 75, sessionId: 's1', fee, hold, charges: [charge, { ...hold }] };

  it('none when charged exactly the round-ups on the saved card, hold released', () => {
    expect(settledProblems(ok)).toEqual([]);
  });

  it('the API’s view is wrong', () => {
    expect(settledProblems({ ...ok, fee: undefined })).toEqual([
      'the API lists no fee for the bill',
    ]);
    expect(
      settledProblems({
        ...ok,
        fee: { billId: 'b1', chargeStatus: 'needs_confirming', chargePence: 74 },
      }),
    ).toEqual([
      'fee kind is none, not hold',
      'the fee has no saved card',
      'the API says the hold was not released',
      'the API says the charge is needs_confirming, not charged',
      'the API charged 74p, expected 75p',
    ]);
    expect(settledProblems({ ...ok, fee: { billId: 'b1', kind: 'hold' } })).toContain(
      'the API says the charge is missing, not charged',
    );
    expect(settledProblems({ ...ok, fee: { billId: 'b1', kind: 'hold' } })).toContain(
      'the API charged nothingp, expected 75p',
    );
  });

  it('Stripe’s hold or charge is wrong', () => {
    expect(
      settledProblems({
        ...ok,
        hold: { ...hold, status: 'succeeded', amount_received: 100 },
        charges: [
          { ...charge, status: 'requires_action', amount_received: 0, payment_method: 'pm_2' },
        ],
      }),
    ).toEqual([
      'the hold is succeeded in Stripe, not canceled',
      '100p was taken from the hold',
      'the charge is requires_action, not succeeded',
      'Stripe received 0p, expected 75p',
      'the charge is not on the card saved with the hold',
    ]);
    expect(settledProblems({ ...ok, hold: { ...hold, payment_method: null } })).toEqual([
      'the charge is not on the card saved with the hold',
    ]);
  });

  it('no charge, or two, for the session', () => {
    expect(settledProblems({ ...ok, charges: [] })).toEqual([
      'Stripe has 0 round-up charges for the session, expected 1',
    ]);
    expect(settledProblems({ ...ok, charges: [charge, charge] })).toEqual([
      'Stripe has 2 round-up charges for the session, expected 1',
    ]);
  });
});
