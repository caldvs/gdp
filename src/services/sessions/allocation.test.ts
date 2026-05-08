import { describe, it, expect } from 'vitest';
import { computeOwed, apportionByWeight } from './allocation.js';
import type { Bill } from '../../types/bills.js';

const billOf = (
  items: Bill['items'],
  tax: number,
  service: number,
): Pick<Bill, 'items' | 'taxPence' | 'serviceChargePence' | 'totalPence'> => {
  const subtotal = items.reduce((s, i) => s + i.unitPricePence * i.quantity, 0);
  return {
    items,
    taxPence: tax,
    serviceChargePence: service,
    totalPence: subtotal + tax + service,
  };
};

const item = (id: string, price: number, qty = 1): Bill['items'][number] => ({
  itemId: id,
  name: `Item ${id}`,
  unitPricePence: price,
  quantity: qty,
  category: 'food',
});

const sumValues = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('apportionByWeight', () => {
  it('returns all zeros when total is 0', () => {
    const out = apportionByWeight(
      0,
      new Map([
        ['a', 100],
        ['b', 200],
      ]),
    );
    expect(out.get('a')).toBe(0);
    expect(out.get('b')).toBe(0);
  });

  it('splits equally when weights are zero', () => {
    const out = apportionByWeight(
      10,
      new Map([
        ['a', 0],
        ['b', 0],
        ['c', 0],
      ]),
    );
    expect(sumValues(out)).toBe(10);
    expect(out.get('a')).toBe(4);
    expect(out.get('b')).toBe(3);
    expect(out.get('c')).toBe(3);
  });

  it('apportions proportionally with no remainder', () => {
    const out = apportionByWeight(
      100,
      new Map([
        ['a', 10],
        ['b', 30],
        ['c', 60],
      ]),
    );
    expect(out.get('a')).toBe(10);
    expect(out.get('b')).toBe(30);
    expect(out.get('c')).toBe(60);
    expect(sumValues(out)).toBe(100);
  });

  it('apportions with remainder using largest-remainder method', () => {
    // weights 100, 100, 100; total 10 → exact 3.33 each → 3 each + 1 remainder
    const out = apportionByWeight(
      10,
      new Map([
        ['c', 100],
        ['a', 100],
        ['b', 100],
      ]),
    );
    expect(sumValues(out)).toBe(10);
    // ties broken by key sort: 'a' gets the extra
    expect(out.get('a')).toBe(4);
    expect(out.get('b')).toBe(3);
    expect(out.get('c')).toBe(3);
  });

  it('always sums to the total exactly (penny-perfect)', () => {
    const totals = [1, 7, 11, 99, 100, 999, 1234];
    for (const total of totals) {
      const out = apportionByWeight(
        total,
        new Map([
          ['a', 17],
          ['b', 23],
          ['c', 41],
          ['d', 19],
        ]),
      );
      expect(sumValues(out)).toBe(total);
    }
  });
});

describe('computeOwed', () => {
  it('throws CLAIMS_INCOMPLETE listing every unclaimed item', () => {
    const bill = billOf([item('i1', 1000), item('i2', 500)], 0, 0);
    const participants = [{ userId: 'u1', claimedItemIds: ['i1'] }];
    expect(() => computeOwed(bill, participants)).toThrow('CLAIMS_INCOMPLETE');
    try {
      computeOwed(bill, participants);
    } catch (err) {
      expect((err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds).toEqual(['i2']);
    }
  });

  it('single participant claims everything → owes the full total', () => {
    const bill = billOf([item('i1', 1450, 2), item('i2', 650, 3)], 100, 200);
    const owed = computeOwed(bill, [{ userId: 'u1', claimedItemIds: ['i1', 'i2'] }]);
    expect(owed.get('u1')).toBe(bill.totalPence);
  });

  it('two participants split a single item evenly with no remainder', () => {
    const bill = billOf([item('i1', 1000)], 0, 0);
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: ['i1'] },
    ]);
    expect(owed.get('a')).toBe(500);
    expect(owed.get('b')).toBe(500);
    expect(sumValues(owed)).toBe(bill.totalPence);
  });

  it('three participants split a single item with a 1p remainder, deterministic by userId', () => {
    const bill = billOf([item('i1', 1001)], 0, 0);
    const owed = computeOwed(bill, [
      { userId: 'c', claimedItemIds: ['i1'] },
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: ['i1'] },
    ]);
    // 1001 / 3 = 333 r 2 → 'a' and 'b' each get +1, 'c' gets 333
    expect(owed.get('a')).toBe(334);
    expect(owed.get('b')).toBe(334);
    expect(owed.get('c')).toBe(333);
    expect(sumValues(owed)).toBe(1001);
  });

  it('proportional service charge across participants with different shares', () => {
    // a claims 8000, b claims 2000, service = 1000 → a should get 800, b 200
    const bill = billOf([item('i1', 8000), item('i2', 2000)], 0, 1000);
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: ['i2'] },
    ]);
    expect(owed.get('a')).toBe(8800);
    expect(owed.get('b')).toBe(2200);
    expect(sumValues(owed)).toBe(bill.totalPence);
  });

  it('reconciles to the penny across complex multi-claimer / odd-amount bills', () => {
    const bill = billOf(
      [
        item('i1', 1733, 3), // shared by a, b, c
        item('i2', 477, 1), // claimed by a only
        item('i3', 891, 2), // shared by b, c
      ],
      127, // tax
      539, // service
    );
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['i1', 'i2'] },
      { userId: 'b', claimedItemIds: ['i1', 'i3'] },
      { userId: 'c', claimedItemIds: ['i1', 'i3'] },
    ]);
    expect(sumValues(owed)).toBe(bill.totalPence);
    // sanity: every owed amount is positive
    for (const v of owed.values()) expect(v).toBeGreaterThan(0);
  });

  it('non-claimer participant owes 0', () => {
    const bill = billOf([item('i1', 1000)], 0, 100);
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: [] },
    ]);
    expect(owed.get('b')).toBe(0);
    expect(owed.get('a')).toBe(1100);
    expect(sumValues(owed)).toBe(bill.totalPence);
  });

  it('handles 100 randomized bills without ever drifting', () => {
    const rand = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
    };
    const random = rand(1234);

    for (let trial = 0; trial < 100; trial += 1) {
      const numItems = 1 + Math.floor(random() * 8);
      const numParticipants = 1 + Math.floor(random() * 6);

      const items = Array.from({ length: numItems }, (_, i) => ({
        itemId: `it-${i}`,
        name: `Item ${i}`,
        unitPricePence: 1 + Math.floor(random() * 5000),
        quantity: 1 + Math.floor(random() * 4),
        category: 'food' as const,
      }));
      const tax = Math.floor(random() * 500);
      const service = Math.floor(random() * 500);
      const bill = billOf(items, tax, service);

      const participants = Array.from({ length: numParticipants }, (_, i) => ({
        userId: `u-${i}`,
        claimedItemIds: items.filter(() => random() > 0.3).map((it) => it.itemId),
      }));

      // Ensure every item is claimed by at least one participant.
      for (const it of items) {
        if (!participants.some((p) => p.claimedItemIds.includes(it.itemId))) {
          participants[0]!.claimedItemIds.push(it.itemId);
        }
      }

      const owed = computeOwed(bill, participants);
      expect(sumValues(owed)).toBe(bill.totalPence);
    }
  });
});
