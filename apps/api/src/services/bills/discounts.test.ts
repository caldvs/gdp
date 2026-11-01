import { describe, expect, it } from 'vitest';
import { applyDiscounts } from './discounts.js';

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

  it('shares the discount when more than one item shares a word with it', () => {
    const out = applyDiscounts(
      [line('Pork Cutlet', 1000), line('Dough Pet Pork', 1000)],
      [{ name: 'Pork deal', amountPence: 200 }],
    );
    expect(out).toEqual([line('Pork Cutlet', 900), line('Dough Pet Pork', 900)]);
  });

  it('keeps whole pence by splitting a line that does not divide evenly', () => {
    const out = applyDiscounts(
      [line('Wine', 350, 3)],
      [{ name: 'Promo', amountPence: 100, appliesTo: 'Wine' }],
    );
    expect(out).toEqual([line('Wine', 317, 2), line('Wine', 316, 1)]);
    expect(total(out)).toBe(950);
  });

  it('shares a discount it cannot place across the bill by price', () => {
    const out = applyDiscounts(
      [line('Pizza', 1500), line('Beer', 500)],
      [{ name: '10% off', amountPence: 200 }],
    );
    expect(out).toEqual([line('Pizza', 1350), line('Beer', 450)]);
  });

  it('shares what is left when a discount is bigger than its item', () => {
    const out = applyDiscounts(
      [line('Bread', 300), line('Pasta', 900)],
      [{ name: 'Comp', amountPence: 600, appliesTo: 'Bread' }],
    );
    expect(out).toEqual([line('Bread', 0), line('Pasta', 600)]);
  });

  it('accepts a discount written as a negative amount and never goes below zero', () => {
    const out = applyDiscounts([line('Olives', 400)], [{ name: 'Comp', amountPence: -1000 }]);
    expect(out).toEqual([line('Olives', 0)]);
  });

  it('leaves the bill alone with no discounts', () => {
    const items = [line('Pizza', 1500)];
    expect(applyDiscounts(items, [])).toEqual(items);
  });

  it('always takes exactly the discount off the bill when it fits', () => {
    for (let amount = 1; amount < 1000; amount += 37) {
      const items = [line('A', 333, 3), line('B', 125, 2), line('C', 1)];
      expect(total(applyDiscounts(items, [{ name: 'x', amountPence: amount }]))).toBe(
        total(items) - amount,
      );
    }
  });
});
