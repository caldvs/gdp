import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { ParsedBillFromImageSchema, type ParsedBillFromImage } from './parser.js';
import { applyDiscounts, type Discount } from './discounts.js';

/** What the bill reader is asked to return. */
export const PROMPT = `You are parsing a UK restaurant bill image into structured JSON for a bill-splitting app.

RULES:
- All monetary amounts are integer PENCE (e.g. "£12.50" → 1250).
- Currency is "GBP".
- "items" should be top-level line items only. Do not separate sub-modifiers (e.g. "extra cheese") unless they appear as their own priced line on the bill.
- If the same item appears N times with the same price, group as quantity: N (single line, not duplicates).
- "category": "food" for edible plates, "drink" for beverages (alcoholic or not), "other" for cover charges and fees.
- Every item's "unitPricePence" is zero or more. A line with a minus price (a discount, deal, promotion or comp, e.g. "Coffee & Cannoli LRG = -4.00") is NOT an item: put it in "discounts" with "amountPence" as a positive number, and "appliesTo" set to the exact "name" of the item in "items" it reduces (e.g. the cannoli for a coffee-and-cannoli deal). Omit "appliesTo" for a discount on the whole bill (e.g. "10% off food") or when you can't tell which item it belongs to.
- Deposits, prepayments and gift cards taken off at the end ("Deposit Red -£130.00") are NOT items or discounts: leave them out. "totalPence" is the total before any deposit is taken off, not the balance left to pay.
- "course" (food items only; omit for drinks and other): "starter" for starters, small plates, antipasti and nibbles like olives or bread; "main" for main dishes, pizzas, pastas, burgers and grills; "side" for sides like chips, fries, salads served alongside, vegetables or extra sauces; "dessert" for desserts, ice cream and cheese boards. Use section headings printed on the bill when present; otherwise judge from the dish name and price. If genuinely unsure, omit it.
- DO NOT include service charge or tax in items. They are separate top-level fields.
- DO NOT invent items.
- Kitchen notes ("rare", "no onions", "table 4") are NOT items.
- "venue.name" is the restaurant, café or bar's trading name. Look for it in the header or logo text at the top, the "Thank you for visiting …" line, or the business name next to the VAT number at the bottom. Copy it as printed (fix only obvious OCR case, e.g. "MAIORA" → "Maiora"). Never put anything else in venue.name; omit it if no name is printed.
- "venue.address": the full address exactly as printed on the bill (street, town, postcode), joined with ", ". Take the name and address from the header or footer, not from card-machine or payment-processor lines. Omit any part that isn't printed; never guess or complete an address from memory.

Return ONLY valid JSON matching this schema, no preamble:
{
  "items": [{"name": string, "unitPricePence": int, "quantity": int, "category": "food"|"drink"|"other", "course"?: "starter"|"main"|"side"|"dessert"}],
  "discounts"?: [{"name": string, "amountPence": int, "appliesTo"?: string}],
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
  const result = ParsedBillFromImageSchema.safeParse(foldDiscounts(parsed));
  if (!result.success) {
    throw new AppError('PARSE_FAILED', `${source} output failed schema validation`, {
      issues: z.flattenError(result.error),
      // The first few problems with the values that caused them, for the logs.
      problems: result.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        value: valueAt(parsed, i.path),
      })),
    });
  }
  if (result.data.items.length === 0) {
    throw new AppError('PARSE_LOW_CONFIDENCE', 'No items could be parsed from the image');
  }
  return result.data;
}

const DiscountSchema = z.object({
  name: z.string().catch('Discount'),
  amountPence: z.number().int(),
  appliesTo: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

type RawItem = { name: string; unitPricePence: number; quantity: number };
const isRawItem = (v: unknown): v is RawItem => {
  const o = v as Partial<RawItem> | null;
  return (
    typeof o?.name === 'string' &&
    typeof o.unitPricePence === 'number' &&
    Number.isInteger(o.unitPricePence) &&
    typeof o.quantity === 'number' &&
    Number.isInteger(o.quantity) &&
    o.quantity > 0
  );
};

/**
 * Folds discount lines into their items before validation, so a bill with a
 * "-4.00" deal line reads instead of failing. Takes the `discounts` the
 * prompt asks for, and also any item the model still gave a minus price
 * (shared across the bill, since it named no item). Leaves anything it
 * doesn't understand for the schema to reject.
 */
function foldDiscounts(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const { discounts: rawDiscounts, ...rest } = parsed as { discounts?: unknown; items?: unknown };
  if (!Array.isArray(rest.items) || !rest.items.every(isRawItem)) return rest;

  const discounts: Discount[] = Array.isArray(rawDiscounts)
    ? rawDiscounts.flatMap((d) => {
        const r = DiscountSchema.safeParse(d);
        return r.success ? [r.data] : [];
      })
    : [];
  const items = rest.items.filter((it) => {
    if (it.unitPricePence >= 0) return true;
    discounts.push({ name: it.name, amountPence: it.unitPricePence * it.quantity });
    return false;
  });
  return { ...rest, items: applyDiscounts(items, discounts) };
}

const valueAt = (root: unknown, path: PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (v, k) =>
      v !== null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined,
    root,
  );
