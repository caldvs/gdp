// Run with: npm run test:scripts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, faintUses, ratio, tokens } from './check-contrast.mjs';

const globals = readFileSync(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');

test('ratio matches WCAG’s known values', () => {
  assert.equal(ratio('#000000', '#ffffff'), 21);
  assert.equal(ratio('#fff', '#fff'), 1);
  assert.equal(ratio('#767676', '#ffffff').toFixed(2), '4.54');
});

test('reads the tokens from the single :root block', () => {
  const t = tokens(globals);
  for (const k of ['ink', 'mute', 'quiet', 'faint', 'accent', 'loud', 'sky', 'bg']) assert.match(t[k], /^#[0-9a-f]{6}$/i, k);
  assert.throws(() => tokens('.x { --a: #fff; }'), /no :root/);
});

test('globals.css passes', () => {
  const { problems, lines } = check(globals);
  assert.deepEqual(problems, []);
  assert.ok(lines.length > 20);
});

test('--quiet text is at least 4.5:1 and --faint icons at least 3:1 (#206)', () => {
  const t = tokens(globals);
  assert.ok(ratio(t.quiet, t.bg) >= 4.5);
  assert.ok(ratio(t.faint, t.bg) >= 3);
});

test('--faint is only on disabled controls and icons (#206)', () => {
  const uses = faintUses(globals);
  assert.ok(uses.includes('.chev'));
  for (const sel of ['.row--muted', '.step--todo']) assert.ok(!uses.includes(sel), sel);
});

test('fails a pair below the minimum, a missing token, and --faint on text', () => {
  const css = `:root { --ink: #111; --bg: #fff; --page: #fff; --hover: #fff; --mute: #bbbbbb; }\n.row--muted { color: var(--faint); }\n.x:disabled, .chev { color: var(--faint); }`;
  const { problems } = check(css);
  assert.ok(problems.some((p) => p.startsWith('--mute on --bg is')));
  assert.ok(problems.some((p) => p === 'missing token for --quiet on --bg'));
  assert.ok(problems.some((p) => p.startsWith('.row--muted uses --faint')));
  assert.ok(!problems.some((p) => p.startsWith('.x:disabled') || p.startsWith('.chev ')));
});
