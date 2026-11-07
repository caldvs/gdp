import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { ParsedBillFromImageSchema, type ParsedBillFromImage } from './parser.js';
import { applyDiscounts, splitTotal, type Discount } from './discounts.js';

/** What the bill reader is asked to return. */
export const PROMPT = `You are parsing a UK restaurant bill image into structured JSON for a bill-splitting app.

RULES:
- All monetary amounts are integer PENCE (e.g. "£12.50" → 1250).
- Currency is "GBP".
- "items" should be top-level line items only. Do not separate sub-modifiers (e.g. "extra cheese") unless they appear as their own priced line on the bill.
- "quantity" is the number printed at the start of the line (1 if there isn't one). "lineTotalPence" is the amount printed at the end of the line: the price of all of them together, not one ("3 House Red = 21.00" → quantity 3, lineTotalPence 2100). Copy the printed amount; don't divide or multiply.
- A long name can wrap onto the next line, and a size line ("125ml", "250ml") can sit between the quantity and the name. The quantity and size belong to the item whose amount is printed next ("2 / 175ml / Pinot Grigio = 16.00" → "Pinot Grigio 175ml", quantity 2, lineTotalPence 1600). Put the size in the name.
- One printed line is one item. Never merge two printed lines, even with the same name: sizes and prices differ.
- Indented lines with their own amount ("Add Bacon = 2.00") are extras: list them as their own item. But when a line is printed at 0.00 and the line or lines under it carry the price, the dish was chosen underneath: that's ONE item, named from both, with the parent's quantity and the priced line's amount ("1 Thai Curry 0.00 / Chicken 14.00 / Red" → "Thai Curry Chicken Red", 1400; "Madras 0.00 / - Lamb Madras 13.95" → "Lamb Madras", 1395).
- "category": "food" for edible plates, "drink" for beverages (alcoholic or not), "other" for cover charges and fees.
- Every item's "lineTotalPence" is zero or more. A line with a minus amount (a discount, deal, promotion or comp, e.g. "Pizza & Pint Deal = -3.00") is NOT an item: put it in "discounts" with "amountPence" as a positive number, and "appliesTo" set to the exact "name" of the item in "items" it reduces (e.g. the pizza for a pizza-and-pint deal). Omit "appliesTo" for a discount on the whole bill (e.g. "10% off food") or when you can't tell which item it belongs to.
- A line that adds money on top (a charity donation like "#CookForUkraine 1.00" or "StreetSmart 1.00") is NOT a discount: it's an item with category "other".
- Deposits, prepayments and gift cards taken off at the end ("Deposit -£50.00", "Prepaid") are NOT items or discounts: leave them out. "totalPence" is the total before any deposit is taken off, not the balance left to pay.
- "course" (food items only; omit for drinks and other): "starter" for starters, small plates, antipasti and nibbles like olives or bread; "main" for main dishes, pizzas, pastas, burgers and grills; "side" for sides like chips, fries, salads served alongside, vegetables or extra sauces; "dessert" for desserts, ice cream and cheese boards. Use section headings printed on the bill when present; otherwise judge from the dish name and price. If genuinely unsure, omit it.
- DO NOT include service charge or tax in items. They are separate top-level fields. "serviceChargePence" is every charge added on top of the items for the table: service charge, gratuity, admin fee, staff fee or card surcharge (add them up if there are several).
- "taxPence" is tax ADDED ON TOP of the item prices only. UK menu prices already include VAT, so a "VAT", "VAT @ 20%" or "Tax included" line printed for information (usually below the total, and not added into it) is NOT tax to add: "taxPence" is 0. Only when the printed total equals items + service + the tax line is it tax to add.
- DO NOT invent items.
- "unsure": only on a line you can't read clearly (faded, cut off, creased, or amounts that don't line up with the names), a few words saying what's unclear ("price faded", "quantity unclear", "name cut off"). Leave it out on every clear line; most bills have none.
- Kitchen notes ("rare", "no onions", "table 4") are NOT items.
- "venue.name" is the restaurant, café or bar's trading name. Look for it in the header or logo text at the top, the "Thank you for visiting …" line, or the business name next to the VAT number at the bottom. Copy it as printed (fix only obvious OCR case, e.g. "MAIORA" → "Maiora"); never expand initials or add words from what you know of the place ("GBK - Soho" stays "GBK - Soho"). Never put anything else in venue.name; omit it if no name is printed.
- "venue.address": the full address exactly as printed on the bill (street, town, postcode), joined with ", ". Take the name and address from the header or footer, not from card-machine or payment-processor lines. Omit any part that isn't printed; never guess or complete an address from memory.

Return ONLY valid JSON matching this schema, no preamble:
{
  "items": [{"name": string, "quantity": int, "lineTotalPence": int, "category": "food"|"drink"|"other", "course"?: "starter"|"main"|"side"|"dessert", "unsure"?: string}],
  "discounts"?: [{"name": string, "amountPence": int, "appliesTo"?: string}],
  "taxPence": int,
  "serviceChargePence": int,
  "totalPence": int,
  "currency": "GBP",
  "venue": {"name": string?, "address": string?}
}`;

/**
 * Turn a model's JSON answer into a bill, or a PARSE_* error. Tolerates a
 * ```json fence, and words before or after the JSON object (the model
 * sometimes explains itself first, despite being asked not to).
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
    const from = body.indexOf('{');
    const to = body.lastIndexOf('}');
    try {
      if (from < 0 || to <= from) throw new Error('no object');
      parsed = JSON.parse(body.slice(from, to + 1));
    } catch {
      throw new AppError('PARSE_FAILED', `${source} returned non-JSON output`, {
        snippet: text.slice(0, 200),
      });
    }
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

/** An item as the model gives it: a line total (asked for) or a unit price (older answers). */
type RawItem = { name: string; quantity: number; lineTotalPence?: number; unitPricePence?: number };
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isRawItem = (v: unknown): v is RawItem => {
  const o = v as Partial<RawItem> | null;
  return (
    typeof o?.name === 'string' &&
    isInt(o.quantity) &&
    o.quantity > 0 &&
    (isInt(o.lineTotalPence) || isInt(o.unitPricePence))
  );
};
const sameName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const lineTotal = (it: RawItem): number => it.lineTotalPence ?? it.unitPricePence! * it.quantity;

/**
 * Turns the model's lines into priced items before validation. Each line's
 * printed total becomes a unit price (the model copies amounts; we do the
 * division, splitting a line that doesn't divide evenly). Discount lines are
 * folded into their items, so a bill with a "-4.00" deal line reads instead
 * of failing: the `discounts` the prompt asks for, and any line the model
 * still gave a minus amount. Leaves anything it doesn't understand for the
 * schema to reject.
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
  // The model sometimes lists a discount again as an item with a plus amount:
  // drop that copy, or the bill charges for the discount.
  const discountNames = new Set(discounts.map((d) => sameName(d.name)));
  const kept = rest.items.filter((raw) => !discountNames.has(sameName(raw.name)));
  const minus = kept.filter((raw) => lineTotal(raw) < 0);
  const plus = kept.filter((raw) => lineTotal(raw) >= 0);
  // A charge added on top ("#CookForUkraine 1.00", a charity or donation line)
  // is sometimes given as a discount. When taking the discounts off misses the
  // printed total and adding them on makes it exactly, they were charges.
  const charges = asCharges(rest as Totals, plus, discounts) ? discounts.splice(0) : [];
  const items = [
    ...plus,
    ...charges.map((d) => ({
      name: d.name,
      quantity: 1,
      lineTotalPence: Math.abs(d.amountPence),
      category: 'other',
    })),
  ].flatMap((raw) => {
    const { lineTotalPence: _total, ...it } = raw;
    return splitTotal({ ...it, unitPricePence: 0 }, lineTotal(raw));
  });
  for (const raw of minus) discounts.push({ name: raw.name, amountPence: lineTotal(raw) });
  return { ...rest, items: applyDiscounts(items, discounts) };
}

type Totals = { totalPence?: unknown; serviceChargePence?: unknown; taxPence?: unknown };

/** True when the bill's printed total only adds up with the discounts added on, not taken off. */
function asCharges(bill: Totals, items: RawItem[], discounts: Discount[]): boolean {
  if (discounts.length === 0 || !isInt(bill.totalPence)) return false;
  const base =
    items.reduce((sum, it) => sum + lineTotal(it), 0) +
    (isInt(bill.serviceChargePence) ? bill.serviceChargePence : 0) +
    (isInt(bill.taxPence) ? bill.taxPence : 0);
  const off = discounts.reduce((sum, d) => sum + Math.abs(d.amountPence), 0);
  return base - off !== bill.totalPence && base + off === bill.totalPence;
}

const valueAt = (root: unknown, path: PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (v, k) =>
      v !== null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined,
    root,
  );
