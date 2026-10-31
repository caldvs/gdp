// Checks text/background pairs from the Calm tokens against WCAG AA
// (4.5:1 for normal text). Run: node scripts/check-contrast.mjs
// Reads the hex values straight out of apps/web/app/globals.css so it
// stays in step with the tokens.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
function block(selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector}`);
  return css.slice(i, css.indexOf('}', i));
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

const themes = {
  light: tokens(block(':root[data-theme="light"]')),
  dark: tokens(block(':root[data-theme="dark"]')),
};
const pairs = [
  ['on-accent', 'accent', 'primary button text'],
  ['accent', 'surface', 'accent text on cards'],
  ['accent', 'bg', 'accent text on the page'],
  ['ink', 'surface', 'body text'],
  ['mute', 'surface', 'muted text'],
  ['mute-2', 'surface', 'quiet text on cards'],
  ['mute-2', 'bg', 'quiet text on the page'],
  ['mute-2', 'surface-2', 'quiet text on insets'],
  ['warn', 'surface', 'warning text'],
  ['error-ink', 'surface', 'error text'],
];
let failed = 0;
for (const [name, t] of Object.entries(themes)) {
  for (const [fg, bg, what] of pairs) {
    if (!t[fg] || !t[bg]) continue;
    const r = ratio(t[fg], t[bg]);
    const ok = r >= 4.5;
    if (!ok) failed += 1;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name.padEnd(5)} ${r.toFixed(2).padStart(5)}:1  --${fg} on --${bg}  (${what})`);
  }
}
process.exit(failed ? 1 : 0);
