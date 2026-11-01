/**
 * Discount lines on a bill ("Coffee & Cannoli LRG  -4.00") are folded into
 * the item they came from, so whoever claims that item gets the discount and
 * every line stays claimable at zero or more. A discount the reader couldn't
 * tie to an item (or one bigger than its item) is shared across the whole bill
 * in proportion to each line's price.
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
 * The item a discount belongs to: the one it names, else the only item that
 * shares a word with the discount's name ("Coffee & Cannoli LRG" → "LGR
 * Cannoli"). -1 when there's no single match.
 */
function targetOf(lines: PricedLine[], d: Discount): number {
  if (d.appliesTo) {
    const exact = lines.findIndex((l) => norm(l.name) === norm(d.appliesTo!));
    if (exact >= 0) return exact;
  }
  const key = words(`${d.appliesTo ?? ''} ${d.name}`);
  const hits = lines.flatMap((l, i) => ([...words(l.name)].some((w) => key.has(w)) ? [i] : []));
  return hits.length === 1 ? hits[0]! : -1;
}

/** Takes `cut` pence off a line, keeping whole pence per unit (may split it in two). */
function reduceLine<T extends PricedLine>(line: T, cut: number): T[] {
  if (cut <= 0) return [line];
  const total = Math.max(0, line.unitPricePence * line.quantity - cut);
  const base = Math.floor(total / line.quantity);
  const extra = total - base * line.quantity; // units that carry one more penny
  if (extra === 0) return [{ ...line, unitPricePence: base }];
  return [
    { ...line, unitPricePence: base + 1, quantity: extra },
    { ...line, unitPricePence: base, quantity: line.quantity - extra },
  ];
}

/** Splits `amount` across lines by line total (largest remainder), never more than a line is worth. */
function share(totals: number[], amount: number): number[] {
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum === 0) return totals.map(() => 0);
  const take = Math.min(amount, sum);
  const exact = totals.map((t) => (t * take) / sum);
  const cuts = exact.map(Math.floor);
  let left = take - cuts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    if (cuts[i]! < totals[i]!) {
      cuts[i]!++;
      left--;
    }
  }
  return cuts;
}

export function applyDiscounts<T extends PricedLine>(items: T[], discounts: Discount[]): T[] {
  const lines = items.map((it) => ({ ...it }));
  const cuts = lines.map(() => 0);
  let unplaced = 0;

  for (const d of discounts) {
    const amount = Math.abs(d.amountPence);
    if (amount === 0) continue;
    const i = targetOf(lines, d);
    if (i < 0) {
      unplaced += amount;
      continue;
    }
    const room = lines[i]!.unitPricePence * lines[i]!.quantity - cuts[i]!;
    const here = Math.min(amount, room);
    cuts[i]! += here;
    unplaced += amount - here;
  }

  if (unplaced > 0) {
    const shares = share(
      lines.map((l, i) => l.unitPricePence * l.quantity - cuts[i]!),
      unplaced,
    );
    shares.forEach((s, i) => (cuts[i]! += s));
  }

  return lines.flatMap((l, i) => reduceLine(l, cuts[i]!));
}
