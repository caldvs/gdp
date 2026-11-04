import { describe, expect, it } from 'vitest';
import { addedTaxPence, mergeRepeatedLines } from './parseService.js';
import type { ParsedBillFromImage } from './parser.js';

type Line = ParsedBillFromImage['items'][number];

describe('addedTaxPence (#176)', () => {
  it('adds no tax when the printed total already includes it (UK VAT line)', () => {
    // Caravan, 4 Nov: items £94.40 + service £11.80 = Total £106.20; VAT £15.73 printed below.
    expect(
      addedTaxPence({ taxPence: 1573, serviceChargePence: 1180, totalPence: 10620 }, 9440),
    ).toBe(0);
  });

  it('allows a penny or two of rounding', () => {
    expect(
      addedTaxPence({ taxPence: 1573, serviceChargePence: 1180, totalPence: 10622 }, 9440),
    ).toBe(0);
  });

  it('keeps tax that the printed total adds on top', () => {
    expect(addedTaxPence({ taxPence: 800, serviceChargePence: 0, totalPence: 4800 }, 4000)).toBe(
      800,
    );
  });

  it('keeps the tax when nothing settles it', () => {
    expect(addedTaxPence({ taxPence: 800, serviceChargePence: 0 }, 4000)).toBe(800);
    expect(addedTaxPence({ taxPence: 800, serviceChargePence: 0, totalPence: 9999 }, 4000)).toBe(
      800,
    );
  });
});

describe('mergeRepeatedLines', () => {
  const line = (name: string, unitPricePence: number, quantity = 1, extra = {}): Line => ({
    name,
    unitPricePence,
    quantity,
    category: 'drink',
    ...extra,
  });

  it('folds repeated lines into one, wherever they are on the receipt', () => {
    // The Mill: two bottles at the top, two more at the bottom.
    const out = mergeRepeatedLines([
      line('Zinfandel BTL', 2150),
      line('Zinfandel BTL', 2150),
      line('Large Coke', 320),
      line('zinfandel  btl ', 2150),
      line('Zinfandel BTL', 2150, 2),
    ]);
    expect(out).toEqual([line('Zinfandel BTL', 2150, 5), line('Large Coke', 320)]);
  });

  it('keeps the subtotal the same', () => {
    const lines = [line('Negroni', 1050), line('Negroni', 1050, 3), line('Water', 0)];
    const sum = (ls: Line[]) => ls.reduce((a, l) => a + l.unitPricePence * l.quantity, 0);
    expect(sum(mergeRepeatedLines(lines))).toBe(sum(lines));
  });

  it('keeps lines apart when the price, category or course differs', () => {
    const out = mergeRepeatedLines([
      line('Zinfandel BTL', 2150),
      line('Zinfandel BTL', 1900),
      line('Mussels', 900, 1, { category: 'food', course: 'starter' }),
      line('Mussels', 900, 1, { category: 'food', course: 'main' }),
      line('Mussels', 900, 1, { category: 'other' }),
    ]);
    expect(out).toHaveLength(5);
  });

  it('leaves a line the reader was unsure of on its own', () => {
    const out = mergeRepeatedLines([
      line('Peroni', 600),
      line('Peroni', 600, 1, { unsure: 'price faded' }),
      line('Peroni', 600),
    ]);
    expect(out).toEqual([
      line('Peroni', 600, 2),
      line('Peroni', 600, 1, { unsure: 'price faded' }),
    ]);
  });

  it("doesn't change what it was given", () => {
    const lines = [line('Peroni', 600), line('Peroni', 600)];
    mergeRepeatedLines(lines);
    expect(lines[0]!.quantity).toBe(1);
  });
});
