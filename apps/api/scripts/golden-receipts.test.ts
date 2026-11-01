import { describe, expect, it } from 'vitest';
import { checkReceipt } from './golden-receipts.js';

const read = {
  items: [
    { unitPricePence: 1200, quantity: 2 },
    { unitPricePence: 550, quantity: 1 },
  ],
  serviceChargePence: 369,
  taxPence: 0,
};

describe('golden receipt check', () => {
  it('passes when the lines add up to the printed total', () => {
    expect(checkReceipt({ totalPence: 3319, lines: 2, servicePence: 369 }, read)).toEqual([]);
  });

  it('says how far out the total is', () => {
    expect(checkReceipt({ totalPence: 3419 }, read)).toEqual([
      'total £33.19, printed £34.19 (£-1.00 out)',
    ]);
  });

  it('checks line count, service and tax when given', () => {
    expect(
      checkReceipt({ totalPence: 3319, lines: 3, servicePence: 300, taxPence: 1 }, read),
    ).toHaveLength(3);
  });
});
