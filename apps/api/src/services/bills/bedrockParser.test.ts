import { describe, it, expect } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import { FallbackBillParser, createBillParser } from './bedrockParser.js';
import { validateParsedBill } from './geminiParser.js';
import type { BillParser, ParsedBillFromImage } from './parser.js';

const bill: ParsedBillFromImage = {
  items: [{ name: 'Pizza', unitPricePence: 1200, quantity: 1, category: 'food' }],
  taxPence: 0,
  serviceChargePence: 150,
  currency: 'GBP',
};

const parser = (
  model: string,
  result: ParsedBillFromImage | AppError,
): BillParser & { calls: number } => {
  const p = {
    model,
    version: 'v1',
    calls: 0,
    parse: () => {
      p.calls += 1;
      return result instanceof AppError ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return p;
};

describe('FallbackBillParser', () => {
  it('uses the primary when it works', async () => {
    const a = parser('bedrock', bill);
    const b = parser('gemini', bill);
    await expect(new FallbackBillParser(a, b).parse(new Uint8Array(), 'r')).resolves.toEqual(bill);
    expect(b.calls).toBe(0);
  });

  it('falls back when the primary fails', async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'Bedrock: ThrottlingException'));
    const b = parser('gemini', bill);
    await expect(new FallbackBillParser(a, b).parse(new Uint8Array(), 'r')).resolves.toEqual(bill);
    expect(b.calls).toBe(1);
  });

  it("doesn't retry a photo nothing could be read from", async () => {
    const a = parser('bedrock', new AppError('PARSE_LOW_CONFIDENCE', 'No items'));
    const b = parser('gemini', bill);
    await expect(new FallbackBillParser(a, b).parse(new Uint8Array(), 'r')).rejects.toMatchObject({
      code: 'PARSE_LOW_CONFIDENCE',
    });
    expect(b.calls).toBe(0);
  });
});

describe('createBillParser', () => {
  it('prefers Bedrock, with Gemini behind it', () => {
    const p = createBillParser({
      bedrockModelId: 'eu.model',
      region: 'eu-west-2',
      geminiApiKey: 'k',
    });
    expect(p).toBeInstanceOf(FallbackBillParser);
    expect(p.model).toBe('eu.model');
  });

  it('uses Gemini alone without a Bedrock model', () => {
    expect(createBillParser({ region: 'eu-west-2', geminiApiKey: 'k' }).model).toMatch(/gemini/);
  });
});

describe('validateParsedBill', () => {
  it('accepts JSON wrapped in a code fence', () => {
    const text = '```json\n' + JSON.stringify(bill) + '\n```';
    expect(validateParsedBill(text, 'Bedrock').items[0]?.name).toBe('Pizza');
  });

  it('names the reader in its errors', () => {
    expect(() => validateParsedBill('not json', 'Bedrock')).toThrow(/Bedrock returned non-JSON/);
  });
});
