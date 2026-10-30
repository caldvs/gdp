import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { ParsedBillFromImageSchema, type ParsedBillFromImage } from './parser.js';

/** What the bill reader is asked to return. */
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
- "venue": the business's trading name and its full address exactly as printed on the bill (street, town, postcode), joined with ", ". Take them from the header or footer, not from card-machine or payment-processor lines. Omit any part that isn't printed; never guess or complete an address from memory.

Return ONLY valid JSON matching this schema, no preamble:
{
  "items": [{"name": string, "unitPricePence": int, "quantity": int, "category": "food"|"drink"|"other", "course"?: "starter"|"main"|"side"|"dessert"}],
  "taxPence": int,
  "serviceChargePence": int,
  "totalPence": int,
  "currency": "GBP",
  "venue": {"name": string?, "address": string?}
}`;

/**
 * Turn a model's JSON answer into a bill, or a PARSE_* error.  Tolerates a ```json fence.
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
