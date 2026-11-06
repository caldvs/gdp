import { describe, it, expect } from 'vitest';
import { computeOwed, apportionByWeight, splitShare } from './allocation.js';
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

  it('single participant claims every unit of every item → owes the full total', () => {
    const bill = billOf([item('i1', 1450, 2), item('i2', 650, 3)], 100, 200);
    // Per-unit semantics: user must claim each individual unit (i1 twice, i2 thrice)
    const owed = computeOwed(bill, [
      { userId: 'u1', claimedItemIds: ['i1', 'i1', 'i2', 'i2', 'i2'] },
    ]);
    expect(owed.get('u1')).toBe(bill.totalPence);
  });

  it('two participants each take one unit of a 2-quantity item', () => {
    // Per-unit replacement for the old "two split a single item" test: a
    // qty=2 item with two diners each claiming one unit.
    const bill = billOf([item('i1', 500, 2)], 0, 0);
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: ['i1'] },
    ]);
    expect(owed.get('a')).toBe(500);
    expect(owed.get('b')).toBe(500);
    expect(sumValues(owed)).toBe(bill.totalPence);
  });

  it('three participants share a 3-quantity item one unit each', () => {
    const bill = billOf([item('i1', 333, 3)], 0, 0);
    const owed = computeOwed(bill, [
      { userId: 'c', claimedItemIds: ['i1'] },
      { userId: 'a', claimedItemIds: ['i1'] },
      { userId: 'b', claimedItemIds: ['i1'] },
    ]);
    expect(owed.get('a')).toBe(333);
    expect(owed.get('b')).toBe(333);
    expect(owed.get('c')).toBe(333);
    expect(sumValues(owed)).toBe(999);
  });

  it('one participant takes 4 of a 6-pack, another takes 2', () => {
    // The motivating case: 6× Guinness; Alice 4, Bob 2.
    const bill = billOf([item('g', 600, 6)], 0, 0);
    const owed = computeOwed(bill, [
      { userId: 'alice', claimedItemIds: ['g', 'g', 'g', 'g'] },
      { userId: 'bob', claimedItemIds: ['g', 'g'] },
    ]);
    expect(owed.get('alice')).toBe(2400);
    expect(owed.get('bob')).toBe(1200);
    expect(sumValues(owed)).toBe(3600);
  });

  it('CLAIMS_INCOMPLETE when a multi-quantity item has units left over', () => {
    const bill = billOf([item('g', 600, 6)], 0, 0);
    expect(() =>
      computeOwed(bill, [
        { userId: 'a', claimedItemIds: ['g', 'g', 'g'] },
        { userId: 'b', claimedItemIds: ['g', 'g'] },
        // 5 of 6 claimed → 1 unit short → throws
      ]),
    ).toThrowError('CLAIMS_INCOMPLETE');
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

      // Per-unit allocation: for each item, distribute exactly `quantity`
      // claims among random participants. Guarantees CLAIMS_INCOMPLETE never
      // fires and exercises the per-unit math at scale.
      const participants = Array.from({ length: numParticipants }, (_, i) => ({
        userId: `u-${i}`,
        claimedItemIds: [] as string[],
      }));
      for (const it of items) {
        for (let unit = 0; unit < it.quantity; unit += 1) {
          const who = participants[Math.floor(random() * participants.length)]!;
          who.claimedItemIds.push(it.itemId);
        }
      }

      const owed = computeOwed(bill, participants);
      expect(sumValues(owed)).toBe(bill.totalPence);
    }
  });

  describe('shared items (ADR-0006)', () => {
    it('splits a £22 bottle equally between 2 sharers', () => {
      const bill = billOf([item('wine', 2200)], 0, 0);
      const participants = [
        { userId: 'a', claimedItemIds: [], sharedItemIds: ['wine'] },
        { userId: 'b', claimedItemIds: [], sharedItemIds: ['wine'] },
      ];
      const owed = computeOwed(bill, participants);
      expect(owed.get('a')).toBe(1100);
      expect(owed.get('b')).toBe(1100);
      expect(sumValues(owed)).toBe(2200);
    });

    it('splits a £22 bottle between 3 sharers with deterministic remainder', () => {
      const bill = billOf([item('wine', 2200)], 0, 0);
      const participants = [
        { userId: 'a', claimedItemIds: [], sharedItemIds: ['wine'] },
        { userId: 'b', claimedItemIds: [], sharedItemIds: ['wine'] },
        { userId: 'c', claimedItemIds: [], sharedItemIds: ['wine'] },
      ];
      const owed = computeOwed(bill, participants);
      // 2200 / 3 = 733.33; one of them gets +1p to make 2200 exactly.
      const values = [owed.get('a')!, owed.get('b')!, owed.get('c')!].sort();
      expect(values).toEqual([733, 733, 734]);
      expect(sumValues(owed)).toBe(2200);
    });

    it('mixes a shared item with unit claims and apportions service correctly', () => {
      const bill = billOf(
        [item('wine', 2200), item('pizza', 1500, 1), item('pasta', 1200, 1)],
        0,
        490, // ~10% on 4900 subtotal
      );
      const participants = [
        { userId: 'a', claimedItemIds: ['pizza'], sharedItemIds: ['wine'] },
        { userId: 'b', claimedItemIds: ['pasta'], sharedItemIds: ['wine'] },
      ];
      const owed = computeOwed(bill, participants);
      expect(sumValues(owed)).toBe(bill.totalPence);
      // Subtotals: a = 1500 + 1100 = 2600; b = 1200 + 1100 = 2300.
      // a gets a slightly bigger slice of service charge than b.
      expect(owed.get('a')!).toBeGreaterThan(owed.get('b')!);
    });

    it('treats an empty share entry (no sharers) as no-share — unit claim path applies', () => {
      const bill = billOf([item('wine', 2200)], 0, 0);
      // No participant has wine in their sharedItemIds → wine has no sharers.
      const participants = [{ userId: 'a', claimedItemIds: [], sharedItemIds: [] as string[] }];
      // Wine quantity 1 still requires a unit claim → CLAIMS_INCOMPLETE.
      expect(() => computeOwed(bill, participants)).toThrow('CLAIMS_INCOMPLETE');
    });

    it('does not require unit claims for items covered by shares', () => {
      const bill = billOf([item('wine', 2200)], 0, 0);
      const participants = [{ userId: 'a', claimedItemIds: [], sharedItemIds: ['wine'] }];
      const owed = computeOwed(bill, participants);
      expect(owed.get('a')).toBe(2200);
    });
  });
});

describe('splitShare', () => {
  it('charges each sharer price / ways, leaving open spots unclaimed', () => {
    const out = splitShare(1290, ['b', 'a'], 3);
    expect([...out.entries()].sort()).toEqual([
      ['a', 430],
      ['b', 430],
    ]);
  });
  it('puts remainder pennies on the lowest userId first', () => {
    const out = splitShare(1000, ['b', 'a', 'c'], 3);
    expect(out.get('a')).toBe(334);
    expect(out.get('b')).toBe(333);
    expect(out.get('c')).toBe(333);
  });
  it('never charges less than an even split between whoever joined', () => {
    expect(splitShare(1000, ['a', 'b', 'c'], 2).get('a')).toBe(334);
  });
});

describe('computeOwed with ways', () => {
  const bill = {
    items: [
      {
        itemId: 'i1',
        name: 'Nachos',
        unitPricePence: 1200,
        quantity: 1,
        category: 'food' as const,
      },
    ],
    taxPence: 0,
    serviceChargePence: 0,
    totalPence: 1200,
  };
  it('treats a split with open spots as incomplete', () => {
    expect(() =>
      computeOwed(
        bill as never,
        [{ userId: 'a', claimedItemIds: [], sharedItemIds: ['i1'] }],
        new Map([['i1', 2]]),
      ),
    ).toThrow('CLAIMS_INCOMPLETE');
  });
});

describe('computeOwed with a split covering several of a line', () => {
  // 4 bottles at £20: 2 split three ways, 2 claimed one each.
  const wine = billOf([item('w', 2000, 4)], 0, 400);
  const people = [
    { userId: 'a', claimedItemIds: ['w'], sharedItemIds: ['w'] },
    { userId: 'b', claimedItemIds: ['w'], sharedItemIds: ['w'] },
    { userId: 'c', claimedItemIds: [], sharedItemIds: ['w'] },
  ];
  const ways = new Map([['w', 3]]);
  const units = new Map([['w', 2]]);

  it('divides the split’s units by its ways and adds the claims', () => {
    const owed = computeOwed(wine, people, ways, units);
    // £40 three ways: 1334, 1333, 1333; a and b also have a £20 bottle.
    // Guests' service rounds down (c: 400 × 1333 / 8000 = 66.6), and the
    // lead (a, the first here) takes the pennies left over.
    expect(owed.get('c')).toBe(1333 + 66);
    expect(owed.get('a')).toBe(1334 + 2000 + 168);
    expect(sumValues(owed)).toBe(wine.totalPence);
  });

  it('is incomplete while a unit is neither claimed nor in the split', () => {
    const fewer = [people[0]!, { ...people[1]!, claimedItemIds: [] }, people[2]!];
    expect(() => computeOwed(wine, fewer, ways, units)).toThrow('CLAIMS_INCOMPLETE');
  });

  it('counts an old split with no units as one of the line', () => {
    expect(() => computeOwed(wine, people, ways)).toThrow('CLAIMS_INCOMPLETE');
  });

  it('takes a shared discount off by what each person had, to the penny (8 Nov 2026)', () => {
    const base = billOf([item('beef', 2600, 2), item('coke', 375)], 0, 697);
    const bill = {
      ...base,
      discounts: [{ name: 'Fork Loyalty Discount', amountPence: 5000 }],
      totalPence: base.totalPence - 5000,
    };
    const owed = computeOwed(bill, [
      { userId: 'a', claimedItemIds: ['beef', 'coke'] },
      { userId: 'b', claimedItemIds: ['beef'] },
    ]);
    expect([...owed.values()].reduce((x, y) => x + y, 0)).toBe(1272);
    // b had 2600 of 5575: 2332 of the discount off, 325 of the service on.
    expect(owed.get('b')).toBe(2600 + 325 - 2332);
    for (const v of owed.values()) expect(v).toBeGreaterThanOrEqual(0);
  });
});
