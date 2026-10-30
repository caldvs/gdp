import type { components } from '../api';

type BillItem = components['schemas']['BillItem'];

// Heuristic: is this bill item likely something a table would split?
//
// Stopgap until the bill parser (Gemini) emits a `shareable` field
// directly. Today we lean on two signals:
//   1. Item name matches a known "share-shaped" pattern (bottle, carafe,
//      platter, etc.).
//   2. The item is in the `drink` category AND the name looks bottled —
//      a "glass of house red" shouldn't show Share, but "house red
//      bottle" should.
//
// Bias: false-negatives over false-positives. A missed Share is a small
// annoyance (long-press still works); a Share button on a side of fries
// looks dumb.

// Words that strongly suggest a shared/portioned item.
const SHARE_PATTERNS: RegExp[] = [
  /\bbottle\b/,
  /\bbtl\b/,
  /\bcarafe\b/,
  /\bpitcher\b/,
  /\bjug\b/,
  /\bmagnum\b/,
  /\bdecanter\b/,
  /\bpint\b/,
  /\bplatter\b/,
  /\bsharing\b/,
  /\bto share\b/,
  /\bfor (the )?table\b/,
  /\bfor (two|2|three|3|four|4)\b/,
  /\bcheese ?board\b/,
  /\bcharcuterie\b/,
  /\bantipasti\b/,
  /\btapas\b/,
  /\btasting menu\b/,
  /\bmezze\b/,
  /\bbao bun set\b/,
];

export function isLikelyShareable(item: Pick<BillItem, 'name' | 'category' | 'quantity'>): boolean {
  // Multi-quantity items use per-unit claiming (1/4 wings each), not
  // share-mode. Share is reserved for single-unit splits.
  if (item.quantity !== 1) return false;
  const name = item.name.toLowerCase();
  return SHARE_PATTERNS.some((re) => re.test(name));
}
