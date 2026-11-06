import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allClaimed, coverLeftovers, itemStatuses, paymentsOpen, unclaimedLines } from './leftovers';
import { billAndSession } from '../test/arbitraries';

const name = (p: { displayName?: string } | undefined) => p?.displayName ?? 'someone';

const bill = {
  billId: 'b1',
  items: [
    { itemId: 'pizza', name: 'Pizza', unitPricePence: 1400, quantity: 1, category: 'food' },
    { itemId: 'beer', name: 'Beer', unitPricePence: 550, quantity: 4, category: 'drink' },
    { itemId: 'wine', name: 'Wine', unitPricePence: 2400, quantity: 1, category: 'drink' },
    { itemId: 'chips', name: 'Chips', unitPricePence: 400, quantity: 2, category: 'food' },
  ],
  subtotalPence: 7200,
  serviceChargePence: 0,
  taxPence: 0,
  totalPence: 7200,
} as never;

const session = {
  participants: [
    { userId: 'lead', displayName: 'Lee', claimedItemIds: ['beer'], sharedItemIds: [] },
    { userId: 'ann', displayName: 'Ann', claimedItemIds: ['pizza', 'beer'], sharedItemIds: ['wine'] },
  ],
  // An open split: one of two spots taken.
  shares: [{ itemId: 'wine', userIds: ['ann'], ways: 2, activity: [] }],
} as never;

describe('itemStatuses', () => {
  it('keeps every line in bill order with what is left and who has it', () => {
    const st = itemStatuses(session, bill, 'lead', name);
    expect(st.map((x) => [x.item.itemId, x.left, x.mine, x.who])).toEqual([
      ['pizza', 0, 0, ['Ann']],
      ['beer', 2, 1, ['you', 'Ann']],
      ['wine', 0, 0, ['Ann']],
      ['chips', 2, 0, []],
    ]);
    expect(st[2]!.share?.ways).toBe(2);
  });

  it('names someone who left the table with the fallback', () => {
    const s = { ...(session as object), shares: [{ itemId: 'wine', userIds: ['gone'], ways: 2, activity: [] }] } as never;
    expect(itemStatuses(s, bill, 'lead', name)[2]!.who).toEqual(['someone']);
  });
});

describe('coverLeftovers', () => {
  it('takes every unclaimed unit outside a split, in one claim list', () => {
    const st = itemStatuses(session, bill, 'lead', name);
    const cover = coverLeftovers(session, st, ['beer']);
    expect(cover.lines.map((x) => x.item.itemId)).toEqual(['beer', 'chips']);
    expect(cover.pence).toBe(2 * 550 + 2 * 400);
    expect(cover.claimedItemIds).toEqual(['beer', 'beer', 'beer', 'chips', 'chips']);
  });

  it('is empty, £0 and leaves the claims alone when nothing is left', () => {
    const s = {
      participants: [{ userId: 'lead', displayName: 'Lee', claimedItemIds: ['pizza', 'beer', 'beer', 'beer', 'beer', 'wine', 'chips', 'chips'], sharedItemIds: [] }],
      shares: [],
    } as never;
    const cover = coverLeftovers(s, itemStatuses(s, bill, 'lead', name), ['x']);
    expect(cover).toEqual({ lines: [], pence: 0, claimedItemIds: ['x'] });
  });

  it('never claims a split item, and covering completes every non-split line (property)', () => {
    fc.assert(
      fc.property(billAndSession({ complete: false }), fc.nat(), ({ bill: b, session: s }, pick) => {
        const lead = s.participants[pick % s.participants.length]!;
        const st = itemStatuses(s as never, b as never, lead.userId, name);
        const cover = coverLeftovers(s as never, st, lead.claimedItemIds);
        const shared = new Set(s.shares.map((x) => x.itemId));
        for (const id of cover.claimedItemIds.slice(lead.claimedItemIds.length)) expect(shared.has(id)).toBe(false);

        // After covering, no line outside a split has anything left.
        const after = {
          ...s,
          participants: s.participants.map((p) => (p.userId === lead.userId ? { ...p, claimedItemIds: cover.claimedItemIds } : p)),
        };
        for (const x of itemStatuses(after as never, b as never, lead.userId, name)) {
          if (!shared.has(x.item.itemId)) expect(x.left).toBe(0);
        }
        // And the price shown is exactly what was added.
        const added = cover.claimedItemIds.slice(lead.claimedItemIds.length);
        const price = new Map(b.items.map((i) => [i.itemId, i.unitPricePence]));
        expect(added.reduce((acc, id) => acc + price.get(id)!, 0)).toBe(cover.pence);
      }),
    );
  });

  it('units left plus units claimed always equals the quantity (property)', () => {
    fc.assert(
      fc.property(billAndSession({ complete: false }), ({ bill: b, session: s }) => {
        const st = itemStatuses(s as never, b as never, s.participants[0]!.userId, name);
        for (const x of st) {
          if (x.share) continue;
          const claimed = s.participants.reduce((n, p) => n + p.claimedItemIds.filter((id) => id === x.item.itemId).length, 0);
          expect(x.left + claimed).toBe(x.item.quantity);
        }
      }),
    );
  });
});

describe('paymentsOpen (#216)', () => {
  const claiming = { ...(session as object), status: 'claiming' } as never;
  const all = {
    status: 'claiming',
    participants: [
      { userId: 'lead', claimedItemIds: ['beer', 'beer', 'chips', 'chips'], sharedItemIds: ['wine'] },
      { userId: 'ann', claimedItemIds: ['pizza', 'beer', 'beer'], sharedItemIds: ['wine'] },
    ],
    shares: [{ itemId: 'wine', userIds: ['ann', 'lead'], ways: 2, activity: [] }],
  } as never;

  it('every line claimed means every unit and every spot in a split', () => {
    expect(unclaimedLines(claiming, bill).map((i) => i.itemId)).toEqual(['beer', 'wine', 'chips']);
    expect(allClaimed(claiming, bill)).toBe(false);
    expect(unclaimedLines(all, bill)).toEqual([]);
    expect(allClaimed(all, bill)).toBe(true);
  });

  it('only the lead opens payments: every line claimed doesn’t', () => {
    expect(paymentsOpen(claiming)).toBe(false);
    expect(paymentsOpen(all)).toBe(false);
    expect(paymentsOpen({ ...(all as object), paymentsOpenedAt: '2026-11-08T10:00:00Z' } as never)).toBe(true);
    expect(paymentsOpen({ ...(claiming as object), paymentsOpenedAt: '2026-11-08T10:00:00Z' } as never)).toBe(true);
  });

  it('a locked or closed bill is open; one being set up isn’t', () => {
    expect(paymentsOpen({ ...(claiming as object), status: 'paying' } as never)).toBe(true);
    expect(paymentsOpen({ ...(claiming as object), status: 'settled' } as never)).toBe(true);
    expect(paymentsOpen({ ...(claiming as object), status: 'setup' } as never)).toBe(false);
  });
});
