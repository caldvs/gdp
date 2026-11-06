import { describe, expect, it } from 'vitest';
import {
  apportionByWeight,
  computeOwed,
  discountPartPence,
  discountPence,
  extrasRate,
  itemsPence,
  nobodyPence,
  owedBeforeRoundUp,
  paymentsAreOpen,
  projectFeePence,
  projectOwedPence,
  projectSubtotalPence,
  sharePence,
  sharesOf,
  splitShare,
  splitsOf,
  unclaimedItemIds,
  withExtrasPence,
} from './owed';

describe('penny-exact shares (8 Nov 2026)', () => {
  const items = [{ itemId: 'x', unitPricePence: 1000, quantity: 3 }];
  const totals = { items, subtotalPence: 3000, serviceChargePence: 375, taxPence: 0, discounts: [] };
  const a = { userId: 'a', claimedItemIds: ['x'] };
  const b = { userId: 'b', claimedItemIds: ['x'] };

  it('rounds a guest down', () => {
    // 1001 × 3375 / 3000 = 1126.125, rounded down.
    expect(withExtrasPence(totals, 1001)).toBe(1126);
    expect(withExtrasPence(totals, 0)).toBe(0);
    // No items on the bill at all: nothing to add.
    expect(withExtrasPence({ ...totals, subtotalPence: 0 }, 500)).toBe(500);
  });

  it('puts what nobody claimed on the lead, and adds up to the bill', () => {
    const table = { creatorUserId: 'a', participants: [a, b] };
    expect(owedBeforeRoundUp(totals, table, b, [])).toBe(1125);
    expect(nobodyPence(totals, table, [])).toBe(1125);
    expect(owedBeforeRoundUp(totals, table, a, [])).toBe(3375 - 1125 - 1125);
  });

  it('works for a lead not at the table yet', () => {
    const table = { creatorUserId: 'lead', participants: [b] };
    expect(owedBeforeRoundUp(totals, table, { userId: 'lead', claimedItemIds: [] }, [])).toBe(3375 - 1125 - 2250);
    expect(nobodyPence(totals, table, [])).toBe(2250);
    expect(sharesOf(totals, new Map([['b', 1000]]), 'lead').byUser.get('lead')).toBe(3375 - 1125);
  });
});

const bill = {
  billId: 'b1',
  items: [
    { itemId: 'pizza', name: 'Pizza', unitPricePence: 1400, quantity: 1, category: 'food' },
    { itemId: 'wine', name: 'Wine', unitPricePence: 2201, quantity: 1, category: 'drink' },
    { itemId: 'beer', name: 'Beer', unitPricePence: 550, quantity: 3, category: 'drink' },
  ],
  subtotalPence: 5251,
  serviceChargePence: 525,
  taxPence: 0,
  totalPence: 5776,
} as never;

const session = {
  participants: [
    { userId: 'alice', claimedItemIds: ['pizza', 'beer'], sharedItemIds: ['wine'] },
    { userId: 'bob', claimedItemIds: ['beer', 'beer'], sharedItemIds: ['wine'] },
  ],
  shares: [{ itemId: 'wine', userIds: ['bob', 'alice'], ways: 2, activity: [] }],
} as never;

describe('owed projection', () => {
  it('splits shares equally, remainder penny to the lowest userId', () => {
    expect(projectSubtotalPence(session, bill, 'alice')).toBe(1400 + 550 + 1101);
    expect(projectSubtotalPence(session, bill, 'bob')).toBe(1100 + 1100);
  });

  it('adds service pro rata', () => {
    // Rounded down (penny-exact, 8 Nov 2026): 2200 × 5776 / 5251 = 2419.9.
    expect(projectOwedPence(session, bill, 'bob')).toBe(Math.floor((2200 * 5776) / 5251));
  });

  it('is zero for someone with no picks', () => {
    expect(projectOwedPence(session, bill, 'carol')).toBe(0);
  });
});

describe('sharePence', () => {
  it('divides by the number of ways, not by who has joined so far', () => {
    expect(sharePence(1290, ['a'], 3, 'a')).toBe(430);
  });
  it('spreads leftover pennies one each in userId order', () => {
    expect([sharePence(1000, ['c', 'a', 'b'], 3, 'a'), sharePence(1000, ['c', 'a', 'b'], 3, 'b')]).toEqual([334, 333]);
  });
  it('quotes the cost of joining for someone not yet in it', () => {
    expect(sharePence(1200, ['a'], 3, 'z')).toBe(400);
  });
});

describe('owed projection edge cases', () => {
  const p = (claimedItemIds: string[]) => ({ userId: 'u1', claimedItemIds, sharedItemIds: [] });

  it('ignores claims and shares on items no longer on the bill', () => {
    const s = { participants: [p(['pizza', 'gone'])], shares: [{ itemId: 'gone', userIds: ['u1'], ways: 2, activity: [] }] } as never;
    expect(projectSubtotalPence(s, bill, 'u1')).toBe(1400);
  });

  it('copes with a session that has no shares field', () => {
    expect(projectSubtotalPence({ participants: [p(['beer'])] } as never, bill, 'u1')).toBe(550);
  });

  it('splits between whoever has joined when ways is missing (legacy)', () => {
    const s = { participants: [p([])], shares: [{ itemId: 'wine', userIds: ['u1', 'u2'], activity: [] }] } as never;
    expect(projectSubtotalPence(s, bill, 'u1')).toBe(sharePence(2201, ['u1', 'u2'], 2, 'u1'));
  });

  it('is zero for someone not at the table', () => {
    expect(projectSubtotalPence({ participants: [], shares: [] } as never, bill, 'nobody')).toBe(0);
  });
});

describe('shared discounts (8 Nov 2026)', () => {
  const holland = { subtotalPence: 5575, serviceChargePence: 697, taxPence: 0, discounts: [{ name: 'Loyalty', amountPence: 5000 }] } as never;
  it('adds up the bill’s discounts; none on older bills', () => {
    expect(discountPence(holland)).toBe(5000);
    expect(discountPence({} as never)).toBe(0);
  });
  it('takes the discount off the extras rate', () => {
    expect(extrasRate(holland)).toBeCloseTo((697 - 5000) / 5575);
  });
  it('gives a diner their part of it by what they had', () => {
    // 375 × 5000 / 5575 = 336.3, rounded up so the service shown is never below zero.
    expect(discountPartPence(holland, 375)).toBe(337);
    expect(discountPartPence({ subtotalPence: 0, discounts: [] } as never, 0)).toBe(0);
  });
});

describe('the split maths the API uses too', () => {
  it('apportions nothing, to nobody, and evenly when nobody has anything', () => {
    expect(apportionByWeight(0, new Map([['a', 5]]))).toEqual(new Map([['a', 0]]));
    expect(apportionByWeight(10, new Map())).toEqual(new Map());
    // No weights at all: pennies in key order.
    expect(apportionByWeight(5, new Map([['b', 0], ['a', 0]]))).toEqual(new Map([['a', 3], ['b', 2]]));
  });

  it('splits a price by largest remainder, open spots going unclaimed', () => {
    expect(splitShare(1000, ['b', 'a'], 3)).toEqual(new Map([['a', 334], ['b', 333]]));
    // Fewer ways than people (old data): one each.
    expect(splitShare(100, ['a', 'b'], 1)).toEqual(new Map([['a', 50], ['b', 50]]));
  });

  it('reads the API’s splits from sharedItemIds and shareSettings', () => {
    const people = [{ userId: 'a', sharedItemIds: ['x', 'y'] }, { userId: 'b', sharedItemIds: ['x'] }, { userId: 'c' }];
    expect(splitsOf(people)).toEqual([
      { itemId: 'x', userIds: ['a', 'b'] },
      { itemId: 'y', userIds: ['a'] },
    ]);
    expect(splitsOf(people, [{ itemId: 'x', ways: 3 }])).toEqual([
      { itemId: 'x', userIds: ['a', 'b'], ways: 3, units: 1 },
      { itemId: 'y', userIds: ['a'] },
    ]);
  });

  it('knows which lines are open, and refuses to share out a bill with any', () => {
    const items = [
      { itemId: 'x', unitPricePence: 300, quantity: 2 },
      { itemId: 'y', unitPricePence: 500, quantity: 1 },
    ];
    const bill = { items, subtotalPence: 1100, serviceChargePence: 110, taxPence: 0, totalPence: 1210 };
    const a = { userId: 'a', claimedItemIds: ['x'] };
    const b = { userId: 'b', claimedItemIds: ['x', 'missing'] };
    // y: a split with a spot open; a split nobody is in is no split.
    expect(unclaimedItemIds(items, [a, b], [{ itemId: 'y', userIds: ['a'], ways: 2 }])).toEqual(['y']);
    expect(unclaimedItemIds(items, [a, b], [{ itemId: 'y', userIds: [] }])).toEqual(['y']);
    let open: string[] = [];
    try {
      computeOwed(bill, { creatorUserId: 'a', participants: [a] }, []);
    } catch (err) {
      expect((err as Error).message).toBe('CLAIMS_INCOMPLETE');
      open = (err as { unclaimedItemIds: string[] }).unclaimedItemIds;
    }
    expect(open).toEqual(['x', 'y']);
    const owed = computeOwed(bill, { creatorUserId: 'a', participants: [a, b] }, [{ itemId: 'y', userIds: ['a', 'b'] }]);
    expect(owed).toEqual(new Map([['a', 605], ['b', 605]]));
  });

  it('opens payments once every line is claimed, early, or once locked', () => {
    expect(paymentsAreOpen({ status: 'setup' }, true)).toBe(false);
    expect(paymentsAreOpen({ status: 'claiming' }, false)).toBe(false);
    expect(paymentsAreOpen({ status: 'claiming' }, true)).toBe(true);
    expect(paymentsAreOpen({ status: 'claiming', paymentsOpenedAt: '2026-11-08T00:00:00Z' }, false)).toBe(true);
    expect(paymentsAreOpen({ status: 'paying' }, false)).toBe(true);
  });

  it('a diner nobody has heard of owes their part of any split they’re in, and no more', () => {
    const bill = { items: [{ itemId: 'x', unitPricePence: 900 }], subtotalPence: 900, serviceChargePence: 0, taxPence: 0 };
    const session = { creatorUserId: 'lead', participants: [], shares: [{ itemId: 'x', userIds: ['ghost'], ways: 3 }] };
    expect(projectSubtotalPence(session, bill, 'ghost')).toBe(300);
    expect(projectOwedPence({ ...session, shares: null }, bill, 'ghost')).toBe(0);
    expect(projectFeePence({ ...session, shares: null, platformFeePence: 100 }, bill, 'ghost')).toBe(0);
    expect(projectSubtotalPence({ ...session, shares: undefined }, bill, 'ghost')).toBe(0);
    expect(itemsPence(bill.items, { userId: 'a', claimedItemIds: ['gone'] }, [{ itemId: 'gone', userIds: ['a'] }])).toBe(0);
  });
});
