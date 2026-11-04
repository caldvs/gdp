import { describe, expect, it } from 'vitest';
import { checkLines, checkReceipt } from './golden-receipts.js';

const read = {
  items: [
    { name: 'Pizza', unitPricePence: 1200, quantity: 2 },
    { name: 'Beer', unitPricePence: 550, quantity: 1 },
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

describe('golden line check', () => {
  const printed = [
    { name: 'Aperol Spritz', quantity: 1, lineTotalPence: 1150 },
    { name: 'Menabrea 0.0', quantity: 2, lineTotalPence: 950 },
    { name: 'Bottega Prosecco 125ml', quantity: 2, lineTotalPence: 1800 },
    { name: 'Angi Secco Cider', quantity: 3, lineTotalPence: 1845 },
  ];

  it('counts lines read right, whatever the order, case or size spelling', () => {
    const out = checkLines(printed, [
      { name: '125 ml Bottega Prosecco', unitPricePence: 900, quantity: 2 },
      { name: 'aperol spritz', unitPricePence: 1150, quantity: 1 },
      { name: 'Menabrea 0.0', unitPricePence: 475, quantity: 2 },
      // An uneven split comes back as two lines with the same name.
      { name: 'Angi Secco Cider', unitPricePence: 615, quantity: 3 },
    ]);
    expect(out).toEqual({ right: 4, problems: [] });
  });

  it('reports a wrong quantity, a missing line and an extra one', () => {
    const out = checkLines(printed, [
      { name: 'Aperol Spritz', unitPricePence: 575, quantity: 2 },
      { name: 'Menabrea 0.0', unitPricePence: 950, quantity: 1 },
      { name: 'Angi Secco Cider', unitPricePence: 615, quantity: 3 },
      { name: 'Garlic Bread', unitPricePence: 500, quantity: 1 },
    ]);
    expect(out.right).toBe(1);
    expect(out.problems).toEqual([
      'Aperol Spritz: read 2 for £11.50, printed 1 for £11.50',
      'Menabrea 0.0: read 1 for £9.50, printed 2 for £9.50',
      'missing 2 × Bottega Prosecco 125ml (£18.00)',
      'extra 1 × Garlic Bread (£5.00)',
    ]);
  });
});

describe('checkReceipt: venue', () => {
  const read = (name?: string) => ({
    items: [{ name: 'Cobra', unitPricePence: 360, quantity: 1 }],
    serviceChargePence: 0,
    taxPence: 0,
    ...(name ? { venue: { name } } : {}),
  });
  it('wants exactly the printed name, or none when the bill names none', () => {
    expect(
      checkReceipt({ totalPence: 360, venue: 'Pot Kettle Black' }, read('POT KETTLE BLACK')),
    ).toEqual([]);
    expect(
      checkReceipt({ totalPence: 360, venue: 'PKB - Angel Gardens' }, read('Pot Kettle Black')),
    ).toEqual(['venue "Pot Kettle Black", printed "PKB - Angel Gardens"']);
    expect(checkReceipt({ totalPence: 360, venue: null }, read('Gusto'))).toEqual([
      'venue "Gusto", bill names none',
    ]);
    expect(checkReceipt({ totalPence: 360, venue: 'Gusto' }, read())).toEqual([
      'no venue, printed "Gusto"',
    ]);
  });
});
