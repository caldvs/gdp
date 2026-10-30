import { describe, it, expect } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import { FallbackBillParser, createBillParser } from './bedrockParser.js';
import { validateParsedBill } from './geminiParser.js';
import {
  parseTimeout,
  withDeadline,
  type BillParser,
  type ParseOptions,
  type ParsedBillFromImage,
} from './parser.js';

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
    await expect(new FallbackBillParser(a, b).parse(new Uint8Array(), 'r')).resolves.toEqual({
      ...bill,
      readBy: { model: 'bedrock', version: 'v1' },
    });
    expect(b.calls).toBe(0);
  });

  it('falls back when the primary fails', async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'Bedrock: ThrottlingException'));
    const b = parser('gemini', bill);
    // The bill is credited to the fallback that read it, not the primary.
    await expect(new FallbackBillParser(a, b).parse(new Uint8Array(), 'r')).resolves.toEqual({
      ...bill,
      readBy: { model: 'gemini', version: 'v1' },
    });
    expect(b.calls).toBe(1);
  });

  it('keeps the innermost reader when fallbacks are nested', async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'down'));
    const b = parser('gemini', new AppError('PARSE_FAILED', 'down'));
    const c = parser('other', bill);
    const chain = new FallbackBillParser(a, new FallbackBillParser(b, c));
    await expect(chain.parse(new Uint8Array(), 'r')).resolves.toMatchObject({
      readBy: { model: 'other' },
    });
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

describe('FallbackBillParser time budget', () => {
  /** A parser that never answers, and fails with a timeout when its signal aborts. */
  const hangs = (model: string): BillParser & { signals: (AbortSignal | undefined)[] } => {
    const p = {
      model,
      version: 'v1',
      signals: [] as (AbortSignal | undefined)[],
      parse: (_image: Uint8Array, _id: string, opts?: ParseOptions) => {
        p.signals.push(opts?.signal);
        return new Promise<never>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(parseTimeout(model)));
        });
      },
    };
    return p;
  };
  const clock = (t: number) => ({ primaryMs: 20, minFallbackMs: 4_000, now: () => t });

  it('gives up on a slow primary and lets the fallback read it', async () => {
    const a = hangs('bedrock');
    const b = parser('gemini', bill);
    const outer = withDeadline(60_000, 0);
    await expect(
      new FallbackBillParser(a, b, clock(1_000)).parse(new Uint8Array(), 'r', { signal: outer }),
    ).resolves.toMatchObject({ readBy: { model: 'gemini' } });
    expect(b.calls).toBe(1);
  });

  it('skips the fallback when too little time is left', async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'Bedrock: ThrottlingException'));
    const b = parser('gemini', bill);
    // Deadline at 10s, and it's already 7s: 3s left is under the 4s minimum.
    const outer = withDeadline(10_000, 0);
    await expect(
      new FallbackBillParser(a, b, clock(7_000)).parse(new Uint8Array(), 'r', { signal: outer }),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' });
    expect(b.calls).toBe(0);
  });

  it('fails as a timeout, without a fallback, once the whole budget is spent', async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'aborted'));
    const b = parser('gemini', bill);
    const outer = AbortSignal.abort();
    await expect(
      new FallbackBillParser(a, b).parse(new Uint8Array(), 'r', { signal: outer }),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' });
    expect(b.calls).toBe(0);
  });

  it("passes the caller's deadline to the fallback", async () => {
    const a = parser('bedrock', new AppError('PARSE_FAILED', 'down'));
    const b = hangs('gemini');
    const outer = withDeadline(30, Date.now());
    await expect(
      new FallbackBillParser(a, b, { primaryMs: 20, minFallbackMs: 0, now: Date.now }).parse(
        new Uint8Array(),
        'r',
        { signal: outer },
      ),
    ).rejects.toMatchObject({ code: 'PARSE_TIMEOUT' });
    expect(b.signals[0]).toBe(outer);
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
