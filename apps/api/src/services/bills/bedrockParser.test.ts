import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
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

  it('names the reader in its errors', () => {
    expect(() => validateParsedBill('not json', 'Bedrock')).toThrow(/Bedrock returned non-JSON/);
  });
});
