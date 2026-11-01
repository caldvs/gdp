#!/usr/bin/env node
// Coverage ratchet for PRs.
//
// Compares each package's coverage-summary.json (Vitest `json-summary`
// reporter) with main's last recorded numbers on the `coverage-baseline`
// branch, and fails when lines or branches drop by more than the tolerance.
// Absolute floors live in each package's vitest.config.ts thresholds; this
// script only stops coverage sliding between PRs.
//
// Check a PR:
//   node scripts/coverage-gate.mjs check \
//     --pkg api=apps/api/coverage/coverage-summary.json \
//     --pkg core=packages/core/coverage/coverage-summary.json \
//     --baseline-dir baseline --tolerance 1 [--allow-drop] [--report report.md]
//
// Record main's numbers (run on push to main):
//   node scripts/coverage-gate.mjs record --pkg api=… --pkg core=… \
//     --baseline-dir baseline --sha <commit>
//
// A package whose summary file is missing (its tests didn't run on this PR)
// is reported from the baseline and never fails.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GATED_METRICS = ['lines', 'branches'];
export const REPORTED_METRICS = ['lines', 'branches', 'functions', 'statements'];
export const COMMENT_MARKER = '<!-- coverage-gate -->';

const round = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n === undefined ? '–' : `${n.toFixed(2)}%`);
const fmtDelta = (d) => (d === undefined ? '' : `${d > 0 ? '+' : ''}${d.toFixed(2)}`);

/**
 * @param {object} input
 * @param {Record<string, object | undefined>} input.current  pkg → summary.total (undefined = not run)
 * @param {Record<string, object | undefined>} input.baseline pkg → baseline.total (undefined = none yet)
 * @param {number} input.tolerance percentage points a metric may drop
 * @param {boolean} [input.allowDrop] skip the ratchet (the coverage-drop-ok label)
 */
export function evaluate({ current, baseline, tolerance, allowDrop = false }) {
  const pkgs = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort();
  const rows = [];
  const failures = [];
  const notes = [];

  for (const pkg of pkgs) {
    const cur = current[pkg];
    const base = baseline[pkg];
    if (!cur) {
      notes.push(`\`${pkg}\`: tests didn't run on this PR; showing main's numbers.`);
    } else if (!base) {
      notes.push(`\`${pkg}\`: no baseline from main yet; ratchet skipped.`);
    }
    for (const metric of REPORTED_METRICS) {
      const now = cur?.[metric]?.pct;
      const was = base?.[metric]?.pct;
      const delta = now !== undefined && was !== undefined ? round(now - was) : undefined;
      const gated = GATED_METRICS.includes(metric);
      let status = '';
      if (gated && delta !== undefined) {
        if (delta < -tolerance) {
          status = allowDrop ? '⚠️ drop allowed' : '❌';
          if (!allowDrop) {
            failures.push(
              `${pkg} ${metric}: ${fmt(was)} → ${fmt(now)} (${fmtDelta(delta)} pt, limit -${tolerance} pt)`,
            );
          }
        } else {
          status = '✅';
        }
      }
      rows.push({ pkg, metric, was, now: cur ? now : was, delta, gated, status });
    }
  }

  const lines = [
    COMMENT_MARKER,
    `### Coverage ${failures.length ? '❌ dropped' : '✅'}`,
    '',
    `Gated: lines and branches may not drop more than ${tolerance} pt below main. Floors are in each package's \`vitest.config.ts\`.`,
    '',
    '| Package | Metric | main | This PR | Δ pt | |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${r.pkg} | ${r.gated ? `**${r.metric}**` : r.metric} | ${fmt(r.was)} | ${fmt(r.now)} | ${fmtDelta(r.delta)} | ${r.status} |`,
    ),
  ];
  if (notes.length) lines.push('', ...notes.map((n) => `- ${n}`));
  if (failures.length) {
    lines.push(
      '',
      '**Failed:**',
      ...failures.map((f) => `- ${f}`),
      '',
      'Add tests, or if the drop is deliberate (e.g. deleting well-tested code), add the `coverage-drop-ok` label and re-run the `coverage` job.',
    );
  } else if (allowDrop) {
    lines.push('', '`coverage-drop-ok` label is set: drops are reported but not enforced.');
  }

  return { rows, failures, markdown: lines.join('\n') + '\n' };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, pkgs: {}, tolerance: 1, allowDrop: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--pkg') {
      const [name, path] = next().split('=');
      if (!name || !path) throw new Error('--pkg expects name=path');
      opts.pkgs[name] = path;
    } else if (arg === '--baseline-dir') opts.baselineDir = next();
    else if (arg === '--tolerance') opts.tolerance = Number(next());
    else if (arg === '--allow-drop') opts.allowDrop = true;
    else if (arg === '--report') opts.report = next();
    else if (arg === '--sha') opts.sha = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (command !== 'check' && command !== 'record') {
    throw new Error('First argument must be "check" or "record"');
  }
  if (!opts.baselineDir) throw new Error('--baseline-dir is required');
  if (!Number.isFinite(opts.tolerance) || opts.tolerance < 0) {
    throw new Error('--tolerance must be a non-negative number');
  }
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  const current = {};
  for (const [pkg, path] of Object.entries(opts.pkgs)) {
    current[pkg] = existsSync(path) ? readJson(path).total : undefined;
  }

  if (opts.command === 'record') {
    if (!opts.sha) throw new Error('record needs --sha');
    mkdirSync(opts.baselineDir, { recursive: true });
    for (const [pkg, total] of Object.entries(current)) {
      if (!total) continue; // keep the previous baseline for packages that didn't run
      writeFileSync(
        join(opts.baselineDir, `${pkg}.json`),
        JSON.stringify({ sha: opts.sha, recordedAt: new Date().toISOString(), total }, null, 2) + '\n',
      );
    }
    return 0;
  }

  const baseline = {};
  for (const pkg of Object.keys(opts.pkgs)) {
    const path = join(opts.baselineDir, `${pkg}.json`);
    baseline[pkg] = existsSync(path) ? readJson(path).total : undefined;
  }
  const result = evaluate({
    current,
    baseline,
    tolerance: opts.tolerance,
    allowDrop: opts.allowDrop,
  });
  if (opts.report) writeFileSync(opts.report, result.markdown);
  process.stdout.write(result.markdown);
  return result.failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`coverage-gate: ${err.message}`);
    process.exitCode = 2;
  }
}
