import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
// The server's maths, imported by path: the client projection must agree
// with what the API charges (ADR-0006).
import { apportionByWeight, computeOwed, splitShare } from '../../../../apps/api/src/services/sessions/allocation';
import { extrasRate, projectOwedPence, projectSubtotalPence, sharePence } from './owed';
import { billAndSession, split } from '../test/arbitraries';

describe('sharePence (property)', () => {
  it('gives each person the floor or ceiling of price ÷ ways', () => {
    fc.assert(
      fc.property(split(), ({ price, members, ways }) => {
        const n = Math.max(ways, members.length);
        for (const u of members) {
          const p = sharePence(price, members, ways, u);
          expect(p === Math.floor(price / n) || p === Math.ceil(price / n)).toBe(true);
        }
      }),
    );
  });

  it('a full split adds up to the price exactly', () => {
    fc.assert(
      fc.property(split(), ({ price, members }) => {
        const sum = members.reduce((acc, u) => acc + sharePence(price, members, members.length, u), 0);
        expect(sum).toBe(price);
      }),
    );
  });

  it('never charges an open split more than the price', () => {
    fc.assert(
      fc.property(split(), ({ price, members, ways }) => {
        const sum = members.reduce((acc, u) => acc + sharePence(price, members, ways, u), 0);
        expect(sum).toBeLessThanOrEqual(price);
      }),
    );
  });

  it("what joining would cost is what you pay once you've joined", () => {
    fc.assert(
      fc.property(split(), fc.uuid(), ({ price, members, ways }, newcomer) => {
        fc.pre(!members.includes(newcomer));
        const quoted = sharePence(price, members, ways, newcomer);
        const after = sharePence(price, [...members, newcomer], ways, newcomer);
        expect(quoted).toBe(after);
      }),
    );
  });

  it('member order does not matter', () => {
    fc.assert(
      fc.property(split(), ({ price, members, ways }) => {
        const reversed = [...members].reverse();
        for (const u of members) {
          expect(sharePence(price, reversed, ways, u)).toBe(sharePence(price, members, ways, u));
        }
      }),
    );
  });
});

describe('client and server agree (property)', () => {
  it('sharePence (core) equals splitShare (API) for every member', () => {
    fc.assert(
      fc.property(split(), ({ price, members, ways }) => {
        const server = splitShare(price, members, ways);
        for (const u of members) expect(sharePence(price, members, ways, u)).toBe(server.get(u));
      }),
    );
  });

  it("the projected subtotal equals the server's subtotal for each diner", () => {
    fc.assert(
      fc.property(billAndSession(), ({ bill, session }) => {
        // Server subtotal: owed with no service or tax.
        const server = computeOwed(
          { ...bill, serviceChargePence: 0, taxPence: 0, totalPence: bill.subtotalPence },
          session.participants,
          new Map(session.shares.map((s) => [s.itemId, s.ways])),
        );
        for (const p of session.participants) {
          expect(projectSubtotalPence(session as never, bill as never, p.userId)).toBe(server.get(p.userId));
        }
      }),
    );
  });

  it('the projected total is within 2p of what the server charges', () => {
    // The client rounds subtotal × (1 + rate) once; the server apportions
    // service and tax separately by largest remainder (±1p each).
    fc.assert(
      fc.property(billAndSession(), ({ bill, session }) => {
        const server = computeOwed(bill, session.participants, new Map(session.shares.map((s) => [s.itemId, s.ways])));
        for (const p of session.participants) {
          const projected = projectOwedPence(session as never, bill as never, p.userId);
          expect(Math.abs(projected - server.get(p.userId)!)).toBeLessThanOrEqual(2);
        }
      }),
    );
  });
});

describe('server allocation (property)', () => {
  it('a complete bill is charged to the penny', () => {
    fc.assert(
      fc.property(billAndSession(), ({ bill, session }) => {
        const owed = computeOwed(bill, session.participants, new Map(session.shares.map((s) => [s.itemId, s.ways])));
        const sum = [...owed.values()].reduce((a, b) => a + b, 0);
        expect(sum).toBe(bill.totalPence);
        for (const v of owed.values()) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('an incomplete bill is refused with the open items', () => {
    fc.assert(
      fc.property(billAndSession({ complete: false }), ({ bill, session }) => {
        const shareByItem = new Map(session.shares.map((s) => [s.itemId, s]));
        const open = bill.items.filter((it) => {
          const sh = shareByItem.get(it.itemId);
          if (sh) return sh.userIds.length < sh.ways;
          const claimed = session.participants.reduce((n, p) => n + p.claimedItemIds.filter((id) => id === it.itemId).length, 0);
          return claimed < it.quantity;
        });
        const run = () => computeOwed(bill, session.participants, new Map(session.shares.map((s) => [s.itemId, s.ways])));
        if (open.length === 0) {
          expect(run).not.toThrow();
          return;
        }
        try {
          run();
          expect.unreachable('computeOwed should refuse an incomplete bill');
        } catch (err) {
          expect((err as Error).message).toBe('CLAIMS_INCOMPLETE');
          expect(new Set((err as { unclaimedItemIds: string[] }).unclaimedItemIds)).toEqual(new Set(open.map((i) => i.itemId)));
        }
      }),
    );
  });

  it('taking one more unit never lowers what you owe', () => {
    fc.assert(
      fc.property(billAndSession(), fc.nat(), fc.nat(), ({ bill, session }, pickItem, pickPerson) => {
        // Add one more unit of an existing claimed item and see the claimer's total rise.
        const claimable = bill.items.filter((it) => !session.shares.some((s) => s.itemId === it.itemId));
        fc.pre(claimable.length > 0);
        const item = claimable[pickItem % claimable.length]!;
        const person = session.participants[pickPerson % session.participants.length]!;
        const ways = new Map(session.shares.map((s) => [s.itemId, s.ways]));
        const before = computeOwed(bill, session.participants, ways).get(person.userId)!;
        const bigger = {
          ...bill,
          items: bill.items.map((it) => (it.itemId === item.itemId ? { ...it, quantity: it.quantity + 1 } : it)),
          subtotalPence: bill.subtotalPence + item.unitPricePence,
          totalPence: bill.totalPence + item.unitPricePence,
        };
        const after = computeOwed(
          bigger,
          session.participants.map((p) => (p.userId === person.userId ? { ...p, claimedItemIds: [...p.claimedItemIds, item.itemId] } : p)),
          ways,
        ).get(person.userId)!;
        // Service and tax are re-apportioned, so allow their rounding (±1p each).
        expect(after).toBeGreaterThanOrEqual(before + item.unitPricePence - 2);
      }),
    );
  });

  it('apportionByWeight always sums to the total, within a penny of exact', () => {
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
          // Deterministic regardless of insertion order.
          const again = apportionByWeight(total, new Map([...weights].reverse()));
          expect([...again].sort()).toEqual([...out].sort());
        },
      ),
    );
  });

  it('extrasRate is zero for an empty bill', () => {
    expect(extrasRate({ subtotalPence: 0, serviceChargePence: 100, taxPence: 0 } as never)).toBe(0);
  });
});
