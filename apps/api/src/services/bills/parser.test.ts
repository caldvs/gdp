import { describe, expect, it } from 'vitest';
import { ParsedBillFromImageSchema } from './parser.js';

const base = { taxPence: 0, serviceChargePence: 0, currency: 'GBP' as const };
const item = (extra: Record<string, unknown>) => ({
  name: 'Lasagne',
  unitPricePence: 1725,
  quantity: 1,
  category: 'food',
  ...extra,
});

describe('ParsedBillFromImageSchema course', () => {
  it('keeps a valid course', () => {
    const r = ParsedBillFromImageSchema.parse({ ...base, items: [item({ course: 'main' })] });
    expect(r.items[0]?.course).toBe('main');
  });

  it('drops null or unknown courses instead of failing the parse', () => {
    const r = ParsedBillFromImageSchema.parse({
      ...base,
      items: [item({ course: null }), item({ course: 'entree' })],
    });
    expect(r.items.map((i) => i.course)).toEqual([undefined, undefined]);
  });

  it('accepts items with no course', () => {
    const r = ParsedBillFromImageSchema.parse({ ...base, items: [item({})] });
    expect(r.items[0]?.course).toBeUndefined();
  });
});

describe('ParsedBillFromImageSchema category', () => {
  it('reads a course given as the category as a food item with that course', () => {
    const r = ParsedBillFromImageSchema.parse({
      ...base,
      items: [item({ category: 'main' }), item({ category: 'Starter', course: 'side' })],
    });
    expect(r.items.map((i) => [i.category, i.course])).toEqual([
      ['food', 'main'],
      ['food', 'side'],
    ]);
  });

  it('accepts a category in the wrong case', () => {
    const r = ParsedBillFromImageSchema.parse({ ...base, items: [item({ category: 'Drink' })] });
    expect(r.items[0]?.category).toBe('drink');
  });

  it('still rejects a category it cannot place', () => {
    expect(() =>
      ParsedBillFromImageSchema.parse({ ...base, items: [item({ category: 'cutlery' })] }),
    ).toThrow();
  });
});

describe('bill prompt: venue name', () => {
  it('asks for the printed trading name and nothing else in venue.name', async () => {
    const { PROMPT } = await import('./billPrompt.js');
    expect(PROMPT).toMatch(/venue\.name" is the restaurant/);
    expect(PROMPT).toMatch(/Never put anything else in venue\.name/);
    expect(PROMPT).not.toMatch(/explain in venue\.name/);
  });
});
