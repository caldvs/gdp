import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockBillParser, createBillParser, parseBox } from './bedrockParser.js';
import { encodeJpeg } from './receiptImages.js';
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

  it('fingerprints the model, version and prompts for the analysis cache', () => {
    const p = new BedrockBillParser('eu.model', 'eu-west-2');
    expect(p.fingerprint).toMatch(new RegExp(`^eu\\.model:${p.version}:[0-9a-f]{8}$`));
    expect(new BedrockBillParser('eu.other', 'eu-west-2').fingerprint).not.toBe(p.fingerprint);
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
    expect(out.discounts).toEqual([]);
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
    // Not one item's: a line of the bill, shared (8 Nov 2026).
    expect(out.items.map((i) => [i.name, i.unitPricePence])).toEqual([
      ['Pizza', 1500],
      ['Beer', 500],
    ]);
    expect(out.discounts).toEqual([{ name: 'Promo', amountPence: 200 }]);
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

  it('turns a "discount" back into a charge when only that makes the printed total (bytart)', () => {
    const items = [
      { name: 'Focaccia', quantity: 1, lineTotalPence: 450, category: 'food' },
      { name: 'Marquise cake', quantity: 1, lineTotalPence: 900, category: 'food' },
    ];
    const read = (extra: object) =>
      validateParsedBill(
        JSON.stringify({ ...bill, serviceChargePence: 0, items, ...extra }),
        'Bedrock',
      ).items.map((i) => [i.name, i.unitPricePence, i.category]);
    const charity = { discounts: [{ name: '#CookForUkraine', amountPence: 100 }] };

    expect(read({ ...charity, totalPence: 1450 })).toEqual([
      ['Focaccia', 450, 'food'],
      ['Marquise cake', 900, 'food'],
      ['#CookForUkraine', 100, 'other'],
    ]);
    // Also listed as an item: still one charge.
    expect(
      read({
        ...charity,
        totalPence: 1450,
        items: [...items, { name: '#CookForUkraine', quantity: 1, lineTotalPence: 100 }],
      }),
    ).toHaveLength(3);
    // A real discount (the total says so) is still taken off, as a line of its own.
    expect(read({ ...charity, totalPence: 1250 }).map((i) => i[1])).toEqual([450, 900]);
    expect(
      validateParsedBill(
        JSON.stringify({ ...bill, serviceChargePence: 0, items, ...charity, totalPence: 1250 }),
        'Bedrock',
      ).discounts,
    ).toEqual([{ name: '#CookForUkraine', amountPence: 100 }]);
    // No printed total to check against: the discount stands.
    expect(read(charity)).toHaveLength(2);
  });

  it('asks for line totals, not unit prices', () => {
    expect(PROMPT).toContain('"lineTotalPence": int');
    expect(PROMPT).not.toContain('"unitPricePence"');
  });

  it('finds the JSON when the model writes something before or after it', () => {
    const json = JSON.stringify({
      items: [{ name: 'Cobra', quantity: 1, lineTotalPence: 360, category: 'drink' }],
      taxPence: 0,
      serviceChargePence: 0,
      currency: 'GBP',
    });
    const text = `I'll read both parts of the receipt together.\n\n${json}\n\nDone.`;
    expect(validateParsedBill(text, 'Bedrock').items[0]?.name).toBe('Cobra');
  });

  it('keeps a short note on a line the reader is unsure of, and drops anything else', () => {
    const text = JSON.stringify({
      items: [
        {
          name: 'Diet Coke',
          quantity: 3,
          lineTotalPence: 825,
          category: 'drink',
          unsure: ' price faded ',
        },
        { name: 'Tricolore', quantity: 1, lineTotalPence: 675, category: 'food', unsure: null },
      ],
      taxPence: 0,
      serviceChargePence: 0,
      currency: 'GBP',
    });
    expect(validateParsedBill(text, 'Bedrock').items.map((i) => i.unsure)).toEqual([
      'price faded',
      undefined,
    ]);
  });

  it('names the reader in its errors', () => {
    expect(() => validateParsedBill('not json', 'Bedrock')).toThrow(/Bedrock returned non-JSON/);
  });
});

describe('BedrockBillParser receipt parts', () => {
  afterEach(() => vi.restoreAllMocks());

  const reply = (text: string) => ({ output: { message: { content: [{ text }] } } });
  const photo = encodeJpeg({
    width: 600,
    height: 2400,
    data: new Uint8Array(600 * 2400 * 4).fill(255),
  });
  type Sent = { input: { messages: { content: { image?: unknown; text?: string }[] }[] } };
  const contentOf = (call: unknown[]) => (call[0] as Sent).input.messages[0]!.content;

  it('finds the receipt, then reads a long one as overlapping parts in one call', async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, 'send')
      .mockResolvedValueOnce(reply('{"left":0.3,"top":0,"right":0.6,"bottom":1}') as never)
      .mockResolvedValueOnce(reply(JSON.stringify(bill)) as never);
    const out = await new BedrockBillParser('eu.model', 'eu-west-2').parse(photo, 'r');
    expect(out.items[0]?.name).toBe('Pizza');
    expect(send).toHaveBeenCalledTimes(2);
    const content = contentOf(send.mock.calls[1]!);
    expect(content.filter((c) => c.image)).toHaveLength(4);
    expect(content.at(-1)?.text).toMatch(/^These 4 images are parts of ONE receipt/);
  });

  it('reads the whole photo when finding the receipt fails', async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, 'send')
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(reply(JSON.stringify(bill)) as never);
    await new BedrockBillParser('eu.model', 'eu-west-2').parse(photo, 'r');
    const content = contentOf(send.mock.calls[1]!);
    expect(content.filter((c) => c.image)).toHaveLength(3); // 600x2400 uncropped is still tall
    expect(content.at(-1)?.text).toMatch(/^These 3 images/);
  });
});

describe('parseBox', () => {
  it('takes the box from the answer', () => {
    expect(parseBox('Here: {"left":0.1,"top":0,"right":0.5,"bottom":1}')).toEqual({
      left: 0.1,
      top: 0,
      right: 0.5,
      bottom: 1,
    });
  });

  it('gives null for anything else', () => {
    expect(parseBox(undefined)).toBeNull();
    expect(parseBox('no idea')).toBeNull();
    expect(parseBox('{"left":"a"}')).toBeNull();
    expect(parseBox('{oops}')).toBeNull();
  });
});
