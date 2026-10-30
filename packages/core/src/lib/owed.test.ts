import { describe, expect, it } from 'vitest';
import { projectOwedPence, projectSubtotalPence } from './owed';

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
  shares: [{ itemId: 'wine', userIds: ['bob', 'alice'] }],
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
