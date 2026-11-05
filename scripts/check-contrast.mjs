// Checks text/background pairs from the Calm tokens against WCAG AA
// (4.5:1 for normal text). Run: node scripts/check-contrast.mjs
// Reads the hex values straight out of apps/web/app/globals.css so it
// stays in step with the tokens.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
// The :root block, found by its selector even when it is reformatted or
// shares a rule with another selector (e.g. `:root, html {`).
function rootBlock() {
  const m = /(?:^|\})\s*:root\b[^{]*\{([^}]*)\}/m.exec(css);
  if (!m) throw new Error('no :root block in globals.css');
  return m[1];
}
function tokens(src) {
  const out = {};
  for (const m of src.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,8})/gi)) out[m[1]] = m[2];
  return out;
}
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const t = tokens(rootBlock());
console.log('note  dark tokens are not read; only the :root block is checked');
const pairs = [
  ['ink', 'bg', 'body text'],
  ['mute', 'bg', 'muted text'],
  ['faint', 'bg', 'faint text on the page'],
  ['accent', 'bg', 'accent text on the page'],
  ['accent', 'accent-tint', 'accent text on tints'],
  ['ok-ink', 'ok-bg', 'success text'],
  ['warn-ink', 'warn-bg', 'warning text'],
  ['err-ink', 'err-bg', 'error text'],
];
let failed = 0;
for (const [fg, bg, what] of pairs) {
  if (!t[fg] || !t[bg]) throw new Error(`--${fg} or --${bg} is not a :root token`);
  const r = ratio(t[fg], t[bg]);
  const ok = r >= 4.5;
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  light ${r.toFixed(2).padStart(5)}:1  --${fg} on --${bg}  (${what})`);
}
process.exit(failed ? 1 : 0);
