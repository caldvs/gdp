import { describe, it, expect } from 'vitest';
import { BedrockBillParser, createBillParser } from './bedrockParser.js';
import { validateParsedBill } from './billPrompt.js';
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

describe('validateParsedBill', () => {
  it('accepts JSON wrapped in a code fence', () => {
    const text = '```json\n' + JSON.stringify(bill) + '\n```';
    expect(validateParsedBill(text, 'Bedrock').items[0]?.name).toBe('Pizza');
  });

  it('names the reader in its errors', () => {
    expect(() => validateParsedBill('not json', 'Bedrock')).toThrow(/Bedrock returned non-JSON/);
  });
});
