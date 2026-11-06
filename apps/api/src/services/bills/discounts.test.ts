import { describe, expect, it } from 'vitest';
import { applyDiscounts as apply } from './discounts.js';

/** The items after folding (the shared lines are checked where they matter). */
const applyDiscounts = (...a: Parameters<typeof apply>) => apply(...a).items;

const line = (name: string, unitPricePence: number, quantity = 1) => ({
  name,
  unitPricePence,
  quantity,
});
const total = (ls: { unitPricePence: number; quantity: number }[]) =>
  ls.reduce((s, l) => s + l.unitPricePence * l.quantity, 0);

describe('applyDiscounts', () => {
  it('folds a discount into the item it names', () => {
    const out = applyDiscounts(
      [line('LGR Cannoli', 350, 2), line('Espresso', 325)],
      [{ name: 'Coffee & Cannoli LRG', amountPence: 400, appliesTo: 'lgr  cannoli' }],
    );
    expect(out).toEqual([line('LGR Cannoli', 150, 2), line('Espresso', 325)]);
  });

  it('finds the item by a shared word when the reader named none', () => {
    const out = applyDiscounts(
      [line('Espresso', 325), line('LGR Cannoli', 700), line('Flat White', 375)],
      [{ name: 'Coffee & Cannoli LRG', amountPence: 400 }],
    );
    expect(out).toEqual([line('Espresso', 325), line('LGR Cannoli', 300), line('Flat White', 375)]);
  });

  it("falls back to the discount's own name when the item it names is ambiguous", () => {
    const out = applyDiscounts(
      [line('Espresso Martini', 1300, 5), line('Espresso', 325), line('LGR Cannoli', 350, 2)],
      [{ name: 'Coffee & Cannoli LRG', amountPence: 400, appliesTo: 'Espresso coffee' }],
    );
    expect(out).toEqual([
      line('Espresso Martini', 1300, 5),
      line('Espresso', 325),
      line('LGR Cannoli', 150, 2),
    ]);
  });

  it('keeps the discount as a shared line when more than one item shares a word with it', () => {
    const out = apply(
      [line('Pork Cutlet', 1000), line('Dough Pet Pork', 1000)],
      [{ name: 'Pork deal', amountPence: 200 }],
    );
    expect(out.items).toEqual([line('Pork Cutlet', 1000), line('Dough Pet Pork', 1000)]);
    expect(out.shared).toEqual([{ name: 'Pork deal', amountPence: 200 }]);
  });

  it('keeps whole pence by splitting a line that does not divide evenly', () => {
    const out = applyDiscounts(
      [line('Wine', 350, 3)],
      [{ name: 'Promo', amountPence: 100, appliesTo: 'Wine' }],
    );
    expect(out).toEqual([line('Wine', 317, 2), line('Wine', 316, 1)]);
    expect(total(out)).toBe(950);
  });

  it('keeps a discount it cannot place as a line of the bill, items at their prices (8 Nov 2026)', () => {
    const out = apply(
      [line('Roast Beef', 2600, 2), line('Diet Coke', 375)],
      [{ name: 'Fork Loyalty Discount £50', amountPence: -5000 }],
    );
    expect(out.items).toEqual([line('Roast Beef', 2600, 2), line('Diet Coke', 375)]);
    expect(out.shared).toEqual([{ name: 'Fork Loyalty Discount £50', amountPence: 5000 }]);
  });

  it('keeps what is left as a shared line when a discount is bigger than its item', () => {
    const out = apply(
      [line('Bread', 300), line('Pasta', 900)],
      [{ name: 'Comp', amountPence: 600, appliesTo: 'Bread' }],
    );
    expect(out.items).toEqual([line('Bread', 0), line('Pasta', 900)]);
    expect(out.shared).toEqual([{ name: 'Comp', amountPence: 300 }]);
  });

  it('accepts a discount written as a negative amount and never takes off more than the items', () => {
    const out = apply([line('Olives', 400)], [{ name: 'Comp', amountPence: -1000 }]);
    expect(out.items).toEqual([line('Olives', 400)]);
    expect(out.shared).toEqual([{ name: 'Comp', amountPence: 400 }]);
  });

  it('leaves the bill alone with no discounts', () => {
    const items = [line('Pizza', 1500)];
    expect(applyDiscounts(items, [])).toEqual(items);
  });

  it('always takes exactly the discount off the bill when it fits, between items and shared lines', () => {
    for (let amount = 1; amount < 1000; amount += 37) {
      const items = [line('A', 333, 3), line('B', 125, 2), line('C', 1)];
      for (const appliesTo of [undefined, 'B']) {
        const out = apply(items, [
          { name: 'x', amountPence: amount, ...(appliesTo ? { appliesTo } : {}) },
        ]);
        const shared = out.shared.reduce((s, d) => s + d.amountPence, 0);
        expect(total(out.items) - shared).toBe(total(items) - amount);
      }
    }
  });
});
