import { z } from 'zod';
import { timed } from '../../logging/timed.js';
import { AppError } from '../../errors/AppError.js';
import {
  ParsedBillFromImageSchema,
  parseTimeout,
  type BillParser,
  type ParseOptions,
  type ParsedBillFromImage,
} from './parser.js';

const MODEL = 'gemini-2.5-flash';
const VERSION = 'v2';

export const PROMPT = `You are parsing a UK restaurant bill image into structured JSON for a bill-splitting app.

RULES:
- All monetary amounts are integer PENCE (e.g. "£12.50" → 1250).
- Currency is "GBP".
- "items" should be top-level line items only. Do not separate sub-modifiers (e.g. "extra cheese") unless they appear as their own priced line on the bill.
- If the same item appears N times with the same price, group as quantity: N (single line, not duplicates).
- "category": "food" for edible plates, "drink" for beverages (alcoholic or not), "other" for cover charges, deposits, fees.
- "course" (food items only; omit for drinks and other): "starter" for starters, small plates, antipasti and nibbles like olives or bread; "main" for main dishes, pizzas, pastas, burgers and grills; "side" for sides like chips, fries, salads served alongside, vegetables or extra sauces; "dessert" for desserts, ice cream and cheese boards. Use section headings printed on the bill when present; otherwise judge from the dish name and price. If genuinely unsure, omit it.
- DO NOT include service charge or tax in items. They are separate top-level fields.
- DO NOT invent items. If the bill is unreadable, return items: [] and explain in venue.name.
- Kitchen notes ("rare", "no onions", "table 4") are NOT items.

Return ONLY valid JSON matching this schema, no preamble:
{
  "items": [{"name": string, "unitPricePence": int, "quantity": int, "category": "food"|"drink"|"other", "course"?: "starter"|"main"|"side"|"dessert"}],
  "taxPence": int,
  "serviceChargePence": int,
  "totalPence": int,
  "currency": "GBP",
  "venue": {"name": string?, "address": string?}
}`;

export class GeminiBillParser implements BillParser {
  readonly model = MODEL;
  readonly version = VERSION;

  constructor(private readonly apiKey: string) {}

  async parse(
    image: Uint8Array,
    requestId: string,
    opts: ParseOptions = {},
  ): Promise<ParsedBillFromImage> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${this.apiKey}`;
    const base64 = Buffer.from(image).toString('base64');

    let response: Response;
    try {
      response = await timed(
        'gemini',
        'generateContent',
        () =>
          fetch(url, {
            method: 'POST',
            signal: opts.signal,
            headers: {
              'content-type': 'application/json',
              'x-request-id': requestId,
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: PROMPT },
                    { inline_data: { mime_type: 'image/jpeg', data: base64 } },
                  ],
                },
              ],
              generationConfig: {
                response_mime_type: 'application/json',
                temperature: 0,
              },
            }),
          }),
        { requestId },
      );
    } catch {
      if (opts.signal?.aborted) throw parseTimeout('Gemini');
      throw new AppError('PARSE_FAILED', 'Failed to reach Gemini API');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError('PARSE_FAILED', `Gemini returned ${response.status}`, {
        status: response.status,
        body: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new AppError('PARSE_FAILED', 'Gemini response missing content');
    }

    return validateParsedBill(text, 'Gemini');
  }
}

/**
 * Turn a model's JSON answer into a bill, or a PARSE_* error. Shared by
 * every parser so they fail the same way. Tolerates a ```json fence.
 */
export function validateParsedBill(text: string, source: string): ParsedBillFromImage {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('PARSE_FAILED', `${source} returned non-JSON output`, {
      snippet: text.slice(0, 200),
    });
  }
  const result = ParsedBillFromImageSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError('PARSE_FAILED', `${source} output failed schema validation`, {
      issues: z.flattenError(result.error),
    });
  }
  if (result.data.items.length === 0) {
    throw new AppError('PARSE_LOW_CONFIDENCE', 'No items could be parsed from the image');
  }
  return result.data;
}

export const createDefaultBillParser = (apiKey: string | undefined): BillParser => {
  if (!apiKey) {
    return {
      model: 'none',
      version: 'v0',
      parse: () =>
        Promise.reject(
          new AppError('INTERNAL_ERROR', 'BillParser not configured (set GEMINI_API_KEY)'),
        ),
    };
  }
  return new GeminiBillParser(apiKey);
};
