// Run with: npm run test:scripts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, main, parseArgs, COMMENT_MARKER } from './coverage-gate.mjs';

const total = (lines, branches, functions = 50, statements = 50) => ({
  lines: { pct: lines },
  branches: { pct: branches },
  functions: { pct: functions },
  statements: { pct: statements },
});

test('passes when coverage is unchanged or up', () => {
  const r = evaluate({
    current: { api: total(60, 40) },
    baseline: { api: total(59, 40) },
    tolerance: 1,
  });
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /\+1\.00/);
});

test('a drop within tolerance passes', () => {
  const r = evaluate({
    current: { api: total(59.01, 39) },
    baseline: { api: total(60, 40) },
    tolerance: 1,
  });
  assert.deepEqual(r.failures, []);
});

test('a drop beyond tolerance fails on lines or branches', () => {
  const r = evaluate({
    current: { api: total(58.9, 40), core: total(50, 38.5) },
    baseline: { api: total(60, 40), core: total(50, 40) },
    tolerance: 1,
  });
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0], /^api lines/);
  assert.match(r.failures[1], /^core branches/);
  assert.match(r.markdown, /coverage-drop-ok/);
});

test('functions and statements are reported but never fail', () => {
  const r = evaluate({
    current: { api: total(60, 40, 10, 10) },
    baseline: { api: total(60, 40, 90, 90) },
    tolerance: 1,
  });
  assert.deepEqual(r.failures, []);
});

test('the coverage-drop-ok label reports drops without failing', () => {
  const r = evaluate({
    current: { api: total(50, 40) },
    baseline: { api: total(60, 40) },
    tolerance: 1,
    allowDrop: true,
  });
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /drop allowed/);
});

test('no baseline yet: ratchet skipped, noted', () => {
  const r = evaluate({ current: { api: total(10, 10) }, baseline: { api: undefined }, tolerance: 1 });
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /no baseline from main yet/);
});

test("a package that didn't run shows main's numbers and passes", () => {
  const r = evaluate({ current: { web: undefined }, baseline: { web: total(70, 60) }, tolerance: 1 });
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /didn't run on this PR/);
  assert.match(r.markdown, /70\.00%/);
});

test('the report carries the sticky-comment marker', () => {
  const r = evaluate({ current: {}, baseline: {}, tolerance: 1 });
  assert.ok(r.markdown.startsWith(COMMENT_MARKER));
});

test('parseArgs validates its input', () => {
  assert.throws(() => parseArgs(['nope', '--baseline-dir', 'x']), /check" or "record/);
  assert.throws(() => parseArgs(['check']), /baseline-dir/);
  assert.throws(() => parseArgs(['check', '--baseline-dir', 'x', '--tolerance', '-1']), /tolerance/);
  assert.throws(() => parseArgs(['check', '--baseline-dir', 'x', '--pkg', 'api']), /name=path/);
  assert.throws(() => parseArgs(['check', '--baseline-dir', 'x', '--what']), /Unknown/);
  const o = parseArgs(['check', '--baseline-dir', 'b', '--pkg', 'api=a.json', '--tolerance', '1']);
  assert.deepEqual(o.pkgs, { api: 'a.json' });
});

test('record then check round-trips through the baseline dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-gate-'));
  const summary = join(dir, 'summary.json');
  const baselineDir = join(dir, 'baseline');
  writeFileSync(summary, JSON.stringify({ total: total(60, 40) }));

  assert.equal(main(['record', '--pkg', `api=${summary}`, '--baseline-dir', baselineDir, '--sha', 'abc']), 0);
  const recorded = JSON.parse(readFileSync(join(baselineDir, 'api.json'), 'utf8'));
  assert.equal(recorded.sha, 'abc');
  assert.equal(recorded.total.lines.pct, 60);

  // A package that didn't run doesn't overwrite or create a baseline.
  main(['record', '--pkg', `core=${join(dir, 'missing.json')}`, '--baseline-dir', baselineDir, '--sha', 'def']);
  assert.equal(existsSync(join(baselineDir, 'core.json')), false);

  writeFileSync(summary, JSON.stringify({ total: total(55, 40) }));
  const report = join(dir, 'report.md');
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.equal(
      main(['check', '--pkg', `api=${summary}`, '--baseline-dir', baselineDir, '--report', report]),
      1,
    );
  } finally {
    process.stdout.write = write;
  }
  assert.match(readFileSync(report, 'utf8'), /api lines/);
});
