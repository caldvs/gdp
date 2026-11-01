import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockBillParser, createBillParser } from './bedrockParser.js';
import { PROMPT, validateParsedBill } from './billPrompt.js';
import type { ParsedBillFromImage } from './parser.js';

const bill: ParsedBillFromImage = {
  items: [{ name: 'Pizza', unitPricePence: 1200, quantity: 1, category: 'food' }],
  taxPence: 0,
  serviceChargePence: 150,
  currency: 'GBP',
};

describe('createBillParser', () => {
  it('reads with Bedrock when a model is set', () => {
    const p = createBillParser({ bedrockModelId: 'eu.model', region: 'eu-west-2' });
    expect(p).toBeInstanceOf(BedrockBillParser);
    expect(p.model).toBe('eu.model');
  });

  it('fails clearly without a Bedrock model', async () => {
    const p = createBillParser({ region: 'eu-west-2' });
    expect(p.model).toBe('none');
    await expect(p.parse(new Uint8Array(), 'r')).rejects.toThrow(/BEDROCK_MODEL_ID/);
  });
});

describe('BedrockBillParser time limit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the signal to Bedrock and reports a timeout when it fires', async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, 'send')
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const signal = AbortSignal.abort();
    await expect(
      new BedrockBillParser('eu.model', 'eu-west-2').parse(new Uint8Array(), 'r', { signal }),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' });
    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  });

  it('still reports other Bedrock errors as PARSE_FAILED', async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('slow down'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429 },
      }),
    );
    await expect(
      new BedrockBillParser('eu.model', 'eu-west-2').parse(new Uint8Array(), 'r', {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PARSE_FAILED', details: { status: 429 } });
  });
});

describe('validateParsedBill', () => {
  it('accepts JSON wrapped in a code fence', () => {
    const text = '```json\n' + JSON.stringify(bill) + '\n```';
    expect(validateParsedBill(text, 'Bedrock').items[0]?.name).toBe('Pizza');
  });

  it('folds a discount into the item it names (the Gusto cannoli deal)', () => {
    const text = JSON.stringify({
      ...bill,
      items: [
        { name: 'LGR Cannoli', unitPricePence: 350, quantity: 2, category: 'food' },
        { name: 'Espresso', unitPricePence: 325, quantity: 1, category: 'drink' },
      ],
      discounts: [{ name: 'Coffee & Cannoli LRG', amountPence: 400, appliesTo: 'LGR Cannoli' }],
    });
    const out = validateParsedBill(text, 'Bedrock');
    expect(out.items.map((i) => [i.name, i.unitPricePence, i.quantity])).toEqual([
      ['LGR Cannoli', 150, 2],
      ['Espresso', 325, 1],
    ]);
    expect(out).not.toHaveProperty('discounts');
  });

  it('reads a bill whose model still gave a line a minus price', () => {
    const text = JSON.stringify({
      ...bill,
      items: [
        { name: 'Pizza', unitPricePence: 1500, quantity: 1, category: 'food' },
        { name: 'Beer', unitPricePence: 500, quantity: 1, category: 'drink' },
        { name: 'Promo', unitPricePence: -200, quantity: 1, category: 'other' },
      ],
    });
    const out = validateParsedBill(text, 'Bedrock');
    expect(out.items.map((i) => [i.name, i.unitPricePence])).toEqual([
      ['Pizza', 1350],
      ['Beer', 450],
    ]);
  });

  it('ignores a malformed discount rather than failing the read', () => {
    const text = JSON.stringify({ ...bill, discounts: [{ name: 'x' }, 'junk'] });
    expect(validateParsedBill(text, 'Bedrock').items[0]?.unitPricePence).toBe(
      bill.items[0]!.unitPricePence,
    );
  });

  it('prices each unit from the printed line total', () => {
    const text = JSON.stringify({
      ...bill,
      items: [
        { name: 'Espresso Martini', quantity: 5, lineTotalPence: 6500, category: 'drink' },
        { name: 'Menabrea Pint', quantity: 3, lineTotalPence: 2025, category: 'drink' },
        { name: 'Jug Water', quantity: 9, lineTotalPence: 0, category: 'drink' },
      ],
    });
    expect(
      validateParsedBill(text, 'Bedrock').items.map((i) => [i.name, i.quantity, i.unitPricePence]),
    ).toEqual([
      ['Espresso Martini', 5, 1300],
      ['Menabrea Pint', 3, 675],
      ['Jug Water', 9, 0],
    ]);
  });

  it('splits a line total that does not divide evenly, keeping the total', () => {
    const text = JSON.stringify({
      ...bill,
      items: [{ name: 'Dough Pet Pork', quantity: 3, lineTotalPence: 2235, category: 'food' }],
    });
    const items = validateParsedBill(text, 'Bedrock').items;
    expect(items.map((i) => [i.quantity, i.unitPricePence])).toEqual([[3, 745]]);
    const odd = validateParsedBill(
      JSON.stringify({
        ...bill,
        items: [{ name: 'Angi Secco Cider', quantity: 3, lineTotalPence: 1846, category: 'drink' }],
      }),
      'Bedrock',
    ).items;
    expect(odd.map((i) => [i.quantity, i.unitPricePence])).toEqual([
      [1, 616],
      [2, 615],
    ]);
  });

  it('treats a minus line total as a discount', () => {
    const text = JSON.stringify({
      ...bill,
      items: [
        { name: 'LGR Cannoli', quantity: 2, lineTotalPence: 700, category: 'food' },
        { name: 'Coffee & Cannoli LRG', quantity: 1, lineTotalPence: -400, category: 'other' },
      ],
    });
    expect(
      validateParsedBill(text, 'Bedrock').items.map((i) => [i.name, i.quantity, i.unitPricePence]),
    ).toEqual([['LGR Cannoli', 2, 150]]);
  });

  it('drops a discount the model also listed as an item', () => {
    const text = JSON.stringify({
      ...bill,
      items: [
        { name: 'LGR Cannoli', quantity: 2, lineTotalPence: 700, category: 'food' },
        { name: 'Coffee & Cannoli LRG', quantity: 1, lineTotalPence: 400, category: 'other' },
      ],
      discounts: [{ name: 'Coffee & Cannoli LRG', amountPence: 400 }],
    });
    expect(
      validateParsedBill(text, 'Bedrock').items.map((i) => [i.name, i.quantity, i.unitPricePence]),
    ).toEqual([['LGR Cannoli', 2, 150]]);
  });

  it('asks for line totals, not unit prices', () => {
    expect(PROMPT).toContain('"lineTotalPence": int');
    expect(PROMPT).not.toContain('"unitPricePence"');
  });

  it('names the reader in its errors', () => {
    expect(() => validateParsedBill('not json', 'Bedrock')).toThrow(/Bedrock returned non-JSON/);
  });
});
