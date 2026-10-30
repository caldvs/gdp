import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { ParsedBillFromImageSchema, type BillParser, type ParsedBillFromImage } from './parser.js';

const MODEL = 'gemini-2.5-flash';
const VERSION = 'v1';

const PROMPT = `You are parsing a UK restaurant bill image into structured JSON for a bill-splitting app.

RULES:
- All monetary amounts are integer PENCE (e.g. "£12.50" → 1250).
- Currency is "GBP".
- "items" should be top-level line items only. Do not separate sub-modifiers (e.g. "extra cheese") unless they appear as their own priced line on the bill.
- If the same item appears N times with the same price, group as quantity: N (single line, not duplicates).
- "category": "food" for edible plates, "drink" for beverages (alcoholic or not), "other" for cover charges, deposits, fees.
- DO NOT include service charge or tax in items. They are separate top-level fields.
- DO NOT invent items. If the bill is unreadable, return items: [] and explain in venue.name.
- Kitchen notes ("rare", "no onions", "table 4") are NOT items.

Return ONLY valid JSON matching this schema, no preamble:
{
  "items": [{"name": string, "unitPricePence": int, "quantity": int, "category": "food"|"drink"|"other"}],
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

  async parse(image: Uint8Array, requestId: string): Promise<ParsedBillFromImage> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${this.apiKey}`;
    const base64 = Buffer.from(image).toString('base64');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: base64 } }],
            },
          ],
          generationConfig: {
            response_mime_type: 'application/json',
            temperature: 0,
          },
        }),
      });
    } catch {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError('PARSE_FAILED', 'Gemini returned non-JSON output', {
        snippet: text.slice(0, 200),
      });
    }

    const result = ParsedBillFromImageSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('PARSE_FAILED', 'Gemini output failed schema validation', {
        issues: z.flattenError(result.error),
      });
    }
    if (result.data.items.length === 0) {
      throw new AppError('PARSE_LOW_CONFIDENCE', 'No items could be parsed from the image');
    }

    return result.data;
  }
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
