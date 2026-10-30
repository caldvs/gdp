import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apportionByWeight, computeOwed, splitShare } from './allocation.js';

// The cross-check against the client's sharePence lives in
// packages/core/src/lib/owed.property.test.ts; these pin the server's own
// invariants so its coverage is measured here too.

const people = fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 10 });

/** A complete bill: every unit claimed by someone, some quantity-1 items split. */
const completeBill = fc
  .record({
    users: people,
    lines: fc.array(
      fc.record({
        price: fc.integer({ min: 1, max: 20_000 }),
        quantity: fc.integer({ min: 1, max: 6 }),
        split: fc.boolean(),
        picks: fc.array(fc.nat(), { minLength: 6, maxLength: 6 }),
        extraWays: fc.integer({ min: 0, max: 2 }),
      }),
      { minLength: 1, maxLength: 12 },
    ),
    service: fc.integer({ min: 0, max: 5_000 }),
    tax: fc.integer({ min: 0, max: 3_000 }),
  })
  .map(({ users, lines, service, tax }) => {
    const participants = users.map((userId) => ({
      userId,
      claimedItemIds: [] as string[],
      sharedItemIds: [] as string[],
    }));
    const ways = new Map<string, number>();
    const items = lines.map((l, i) => {
      const itemId = `item-${String(i).padStart(2, '0')}`;
      if (l.split && users.length > 1) {
        const members = [...new Set(l.picks.map((n) => n % users.length))];
        for (const m of members) participants[m]!.sharedItemIds.push(itemId);
        // Some splits were opened with ways = people in them, some with more
        // ways that were then filled; both are complete.
        ways.set(itemId, members.length);
        return {
          itemId,
          name: itemId,
          unitPricePence: l.price,
          quantity: 1,
          category: 'food' as const,
        };
      }
      for (let u = 0; u < l.quantity; u++) {
        participants[l.picks[u % 6]! % users.length]!.claimedItemIds.push(itemId);
      }
      return {
        itemId,
        name: itemId,
        unitPricePence: l.price,
        quantity: l.quantity,
        category: 'food' as const,
      };
    });
    const subtotal = items.reduce((a, it) => a + it.unitPricePence * it.quantity, 0);
    return {
      bill: {
        items,
        serviceChargePence: service,
        taxPence: tax,
        totalPence: subtotal + service + tax,
      },
      participants,
      ways,
    };
  });

describe('allocation (property)', () => {
  it('a complete bill is charged to the penny, nobody negative', () => {
    fc.assert(
      fc.property(completeBill, ({ bill, participants, ways }) => {
        const owed = computeOwed(bill, participants, ways);
        expect([...owed.values()].reduce((a, b) => a + b, 0)).toBe(bill.totalPence);
        for (const v of owed.values()) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('removing one claimed unit makes the bill incomplete', () => {
    fc.assert(
      fc.property(completeBill, ({ bill, participants, ways }) => {
        const who = participants.find((p) => p.claimedItemIds.length > 0);
        fc.pre(who !== undefined);
        const dropped = who.claimedItemIds[0]!;
        const fewer = participants.map((p) =>
          p === who ? { ...p, claimedItemIds: p.claimedItemIds.slice(1) } : p,
        );
        expect(() => computeOwed(bill, fewer, ways)).toThrow('CLAIMS_INCOMPLETE');
        try {
          computeOwed(bill, fewer, ways);
        } catch (err) {
          expect((err as { unclaimedItemIds: string[] }).unclaimedItemIds).toContain(dropped);
        }
      }),
    );
  });

  it('a split with an open spot is incomplete', () => {
    fc.assert(
      fc.property(completeBill, ({ bill, participants, ways }) => {
        fc.pre(ways.size > 0);
        const [itemId, n] = [...ways][0]!;
        const wider = new Map(ways).set(itemId, n + 1);
        expect(() => computeOwed(bill, participants, wider)).toThrow('CLAIMS_INCOMPLETE');
      }),
    );
  });

  it('splitShare gives the floor or ceiling of price ÷ ways and never more than the price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        people,
        fc.integer({ min: 0, max: 4 }),
        (price, sharers, extra) => {
          const ways = sharers.length + extra;
          const out = splitShare(price, sharers, ways);
          expect([...out.keys()].sort()).toEqual([...sharers].sort());
          for (const v of out.values()) {
            expect(v === Math.floor(price / ways) || v === Math.ceil(price / ways)).toBe(true);
          }
          const sum = [...out.values()].reduce((a, b) => a + b, 0);
          if (extra === 0) expect(sum).toBe(price);
          else expect(sum).toBeLessThanOrEqual(price);
        },
      ),
    );
  });

  it('splitShare treats ways below the number of sharers as the sharer count (legacy)', () => {
    const out = splitShare(1001, ['a', 'b', 'c'], 1);
    expect([...out.values()].reduce((x, y) => x + y, 0)).toBe(1001);
  });

  it('apportionByWeight sums to the total, within a penny of exact, any order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.dictionary(fc.uuid(), fc.integer({ min: 0, max: 100_000 }), { minKeys: 1, maxKeys: 12 }),
        (total, dict) => {
          const weights = new Map(Object.entries(dict));
          const out = apportionByWeight(total, weights);
          expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(total);
          const sumW = [...weights.values()].reduce((a, b) => a + b, 0);
          for (const [k, w] of weights) {
            const exact = sumW === 0 ? total / weights.size : (w * total) / sumW;
            expect(Math.abs(out.get(k)! - exact)).toBeLessThan(1);
          }
          const again = apportionByWeight(total, new Map([...weights].reverse()));
          expect([...again].sort()).toEqual([...out].sort());
        },
      ),
    );
  });

  it('apportionByWeight with all-zero weights splits equally, pennies in key order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), people, (total, keys) => {
        const out = apportionByWeight(total, new Map(keys.map((k) => [k, 0])));
        const sorted = [...keys].sort();
        const base = Math.floor(total / keys.length);
        const rem = total - base * keys.length;
        sorted.forEach((k, i) => expect(out.get(k)).toBe(base + (i < rem ? 1 : 0)));
      }),
    );
  });

  it('apportionByWeight with no keys is empty', () => {
    expect(apportionByWeight(500, new Map()).size).toBe(0);
  });
});
