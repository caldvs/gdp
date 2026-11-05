import { describe, expect, it } from 'vitest';
import { sharePenceFor } from './mySessions.js';
import type { Participant } from '../../types/sessions.js';

const PIZZA = '00000000-0000-4000-8000-000000000001';
const WINE = '00000000-0000-4000-8000-000000000002';
const bill = {
  items: [
    { itemId: PIZZA, name: 'Pizza', unitPricePence: 1000, quantity: 1 },
    { itemId: WINE, name: 'Wine', unitPricePence: 1001, quantity: 1 },
  ],
  subtotalPence: 2001,
  serviceChargePence: 0,
  taxPence: 0,
  totalPence: 2001,
} as Parameters<typeof sharePenceFor>[0];

const me = (over: Partial<Participant> = {}): Participant => ({
  userId: 'b-me',
  displayName: 'Me',
  claimedItemIds: [],
  sharedItemIds: [],
  payment: { status: 'unpaid' },
  readyToLock: false,
  ...over,
});
const meta = { status: 'claiming' as const, creatorUserId: 'a-lead' };
const split = (userIds?: string[]) => ({
  itemId: WINE,
  ways: 2,
  version: 1,
  activity: [],
  ...(userIds && { userIds }),
});

describe('sharePenceFor', () => {
  it('gives the split’s odd penny to the lower userId', () => {
    const p = me({ sharedItemIds: [WINE] });
    expect(sharePenceFor(bill, meta, p, [split(['a-lead', 'b-me'])])).toBe(500);
  });

  it('counts the caller alone on a split from before userIds were kept', () => {
    const p = me({ sharedItemIds: [WINE] });
    expect(sharePenceFor(bill, meta, p, [split()])).toBe(501);
  });

  it('ignores a split row the caller has left', () => {
    const p = me({ claimedItemIds: [PIZZA] });
    expect(sharePenceFor(bill, meta, p, [split(['a-lead', 'b-me'])])).toBe(1000);
  });

  it('adds a guest’s round-up on a hold, not the lead’s', () => {
    const p = me({ sharedItemIds: [WINE] });
    const held = { ...meta, platformFeePence: 100 };
    expect(sharePenceFor(bill, held, p, [split(['a-lead', 'b-me'])])).toBe(500);
    const lead = me({ userId: 'a-lead', sharedItemIds: [WINE] });
    expect(sharePenceFor(bill, held, lead, [split(['a-lead', 'b-me'])])).toBe(501);
    const dearer = {
      ...bill,
      items: [{ ...bill.items[0]!, unitPricePence: 1050 }, bill.items[1]!],
    };
    const guest = me({ claimedItemIds: [PIZZA] });
    expect(sharePenceFor(dearer, held, guest, [])).toBe(1100);
    expect(sharePenceFor(dearer, meta, guest, [])).toBe(1050);
  });

  it('uses the locked amount once claims are locked', () => {
    const p = me({ claimedItemIds: [PIZZA], owedPence: 1234 });
    expect(sharePenceFor(bill, { ...meta, status: 'paying' }, p, [])).toBe(1234);
    expect(sharePenceFor(bill, { ...meta, status: 'settled' }, p, [])).toBe(1234);
    expect(sharePenceFor(bill, meta, p, [])).toBe(1000);
  });
});
