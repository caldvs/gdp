// Checks the Sky tokens' colour pairs against WCAG AA, and that --faint is
// only used where contrast doesn't apply (disabled controls) or where 3:1
// is enough (icons). Run: npm run check:contrast
// Reads the hex values straight out of apps/web/app/globals.css's :root, so
// it stays in step with the tokens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** WCAG minimums: normal text, and large text or icons and other non-text. */
export const TEXT = 4.5;
export const LARGE = 3;

/** The custom properties with a hex value in the first `:root { ... }` block. */
export function tokens(css) {
  const m = css.match(/(?:^|\n)\s*:root\s*\{([^}]*)\}/);
  if (!m) throw new Error('no :root block in globals.css');
  const out = {};
  for (const t of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,8})\b/gi)) out[t[1]] = t[2];
  return out;
}

function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** [foreground, background, minimum, what]. A name is a token; `#...` is a literal colour. */
export const pairs = [
  ['ink', 'bg', TEXT, 'body text'],
  ['ink', 'page', TEXT, 'body text on the page'],
  ['ink', 'hover', TEXT, 'text on a hovered or mine row'],
  ['mute', 'bg', TEXT, 'muted text'],
  ['mute', 'page', TEXT, 'muted text on the page'],
  ['mute', 'hover', TEXT, 'muted text on a hovered row'],
  ['quiet', 'bg', TEXT, 'quiet text (Nobody’s joined yet, steps to come)'],
  ['quiet', 'page', TEXT, 'quiet text on the page'],
  ['quiet', 'hover', TEXT, 'quiet text on a hovered row'],
  ['accent', 'bg', TEXT, 'links and selected states'],
  ['accent', 'page', TEXT, 'links on the page'],
  ['accent', 'accent-tint', TEXT, 'accent text on its tint'],
  ['#ffffff', 'accent', TEXT, 'a claimed button'],
  ['#ffffff', 'accent-hover', TEXT, 'a claimed button, hovered'],
  ['#ffffff', 'loud', TEXT, 'the main button'],
  ['#ffffff', 'loud-hover', TEXT, 'the main button, hovered'],
  ['#ffffff', 'sky', LARGE, 'the header (large text only)'],
  ['ok-ink', 'ok-bg', TEXT, 'ok badge'],
  ['ok-ink', 'bg', TEXT, 'ok text'],
  ['warn-ink', 'warn-bg', TEXT, 'warning badge'],
  ['warn-ink', 'bg', TEXT, 'warning text'],
  ['err-ink', 'err-bg', TEXT, 'error notice'],
  ['err-ink', 'bg', TEXT, 'error text'],
  ['faint', 'bg', LARGE, 'icons (chevrons)'],
  ['faint', 'hover', LARGE, 'icons on a hovered row'],
];

/**
 * Rules allowed to colour with --faint: disabled controls (exempt from
 * contrast) and icons (3:1). Text needs --quiet or darker.
 */
export const FAINT_OK = [/:disabled\b/, /\[disabled\]/, /\[aria-disabled/, /^\.chev$/];

/** Selectors whose declarations use var(--faint), split per selector. */
export function faintUses(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/var\(--faint\)/.test(m[2])) continue;
    for (const sel of m[1].split(',')) out.push(sel.trim());
  }
  return out;
}

/** Every problem in the stylesheet, plus a line per pair for the log. */
export function check(css) {
  const t = tokens(css);
  const colour = (n) => (n.startsWith('#') ? n : t[n]);
  const lines = [];
  const problems = [];
  for (const [fg, bg, min, what] of pairs) {
    const [f, b] = [colour(fg), colour(bg)];
    const label = `${fg.startsWith('#') ? fg : `--${fg}`} on --${bg}`;
    if (!f || !b) {
      problems.push(`missing token for ${label}`);
      continue;
    }
    const r = ratio(f, b);
    const ok = r >= min;
    lines.push(`${ok ? 'pass' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1 (needs ${min})  ${label}  (${what})`);
    if (!ok) problems.push(`${label} is ${r.toFixed(2)}:1, needs ${min}:1 (${what})`);
  }
  for (const sel of faintUses(css)) {
    if (!FAINT_OK.some((re) => re.test(sel))) problems.push(`${sel} uses --faint, which is for disabled controls and icons only: use --quiet for text`);
  }
  return { lines, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = readFileSync(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
  const { lines, problems } = check(css);
  for (const l of lines) console.log(l);
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(problems.length ? 1 : 0);
}
