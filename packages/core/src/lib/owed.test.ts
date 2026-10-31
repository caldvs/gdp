import { describe, expect, it } from 'vitest';
import { projectOwedPence, projectSubtotalPence, sharePence } from './owed';

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
    expect(projectOwedPence(session, bill, 'bob')).toBe(Math.round(2200 * (1 + 525 / 5251)));
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
