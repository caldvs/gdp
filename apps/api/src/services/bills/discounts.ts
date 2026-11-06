/**
 * Discount lines on a bill ("Coffee & Cannoli LRG  -4.00") are folded into
 * the item they came from, so whoever claims that item gets the discount and
 * every line stays claimable at zero or more. A discount the reader couldn't
 * tie to an item (or what's left of one bigger than its item) stays a line of
 * its own on the bill, shared by what each person had (Callum, 8 Nov 2026),
 * never more than the items come to.
 */

export type PricedLine = { name: string; unitPricePence: number; quantity: number };
export type Discount = { name: string; amountPence: number; appliesTo?: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const words = (s: string) =>
  new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

/**
 * The item a discount belongs to: the one it names exactly, else the only item
 * sharing a word with the name it gives for the item, else the only item
 * sharing a word with the discount's own name ("Coffee & Cannoli LRG" → "LGR
 * Cannoli"). -1 when there's no single match.
 */
function targetOf(lines: PricedLine[], d: Discount): number {
  if (d.appliesTo) {
    const exact = lines.findIndex((l) => norm(l.name) === norm(d.appliesTo!));
    if (exact >= 0) return exact;
  }
  for (const text of [d.appliesTo, d.name]) {
    if (!text) continue;
    const key = words(text);
    const hits = new Set(
      lines.flatMap((l) => ([...words(l.name)].some((w) => key.has(w)) ? [norm(l.name)] : [])),
    );
    if (hits.size === 1) {
      const [name] = hits;
      return lines.findIndex((l) => norm(l.name) === name);
    }
  }
  return -1;
}

/**
 * Prices a line from what it costs in all (`total` pence over `line.quantity`
 * units), keeping whole pence per unit: a total that doesn't divide evenly
 * becomes two lines, the first carrying the extra pennies.
 */
export function splitTotal<T extends PricedLine>(line: T, total: number): T[] {
  const base = Math.floor(total / line.quantity);
  const extra = total - base * line.quantity; // units that carry one more penny
  if (extra === 0) return [{ ...line, unitPricePence: base }];
  return [
    { ...line, unitPricePence: base + 1, quantity: extra },
    { ...line, unitPricePence: base, quantity: line.quantity - extra },
  ];
}

/** Takes `cut` pence off a line, keeping whole pence per unit (may split it in two). */
function reduceLine<T extends PricedLine>(line: T, cut: number): T[] {
  if (cut <= 0) return [line];
  return splitTotal(line, Math.max(0, line.unitPricePence * line.quantity - cut));
}

/** A discount left as its own line on the bill, shared by everyone. */
export type SharedDiscount = { name: string; amountPence: number };

export function applyDiscounts<T extends PricedLine>(
  items: T[],
  discounts: Discount[],
): { items: T[]; shared: SharedDiscount[] } {
  const lines = items.map((it) => ({ ...it }));
  const cuts = lines.map(() => 0);
  const unplaced: SharedDiscount[] = [];

  for (const d of discounts) {
    const amount = Math.abs(d.amountPence);
    if (amount === 0) continue;
    const i = targetOf(lines, d);
    if (i < 0) {
      unplaced.push({ name: d.name, amountPence: amount });
      continue;
    }
    const room = lines[i]!.unitPricePence * lines[i]!.quantity - cuts[i]!;
    const here = Math.min(amount, room);
    cuts[i]! += here;
    if (amount > here) unplaced.push({ name: d.name, amountPence: amount - here });
  }

  // Never more off than the items come to.
  let room = lines.reduce((acc, l, i) => acc + l.unitPricePence * l.quantity - cuts[i]!, 0);
  const shared: SharedDiscount[] = [];
  for (const d of unplaced) {
    const here = Math.min(d.amountPence, room);
    if (here <= 0) break;
    room -= here;
    const same = shared.find((s) => s.name === d.name);
    if (same) same.amountPence += here;
    else shared.push({ name: d.name.trim().slice(0, 200) || 'Discount', amountPence: here });
  }

  return { items: lines.flatMap((l, i) => reduceLine(l, cuts[i]!)), shared };
}
