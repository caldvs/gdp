import { describe, expect, it } from 'vitest';
import { addedTaxPence } from './parseService.js';

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
