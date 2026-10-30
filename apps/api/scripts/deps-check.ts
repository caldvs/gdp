/* eslint-disable no-console -- CLI script, console is the whole point */

/**
 * Post-deploy dependency check: invokes the deployed Lambda with
 * `{ "gdpSelfCheck": true }` so it checks Stripe, Bedrock and SES with
 * its own config and IAM role (see src/ops/selfCheck.ts).
 * Exits 1 if a required dependency fails. In GitHub Actions, failures and
 * warnings also appear as annotations and in the job summary.
 *
 * Usage (needs the AWS CLI and credentials for the account):
 *   tsx scripts/deps-check.ts <function-name>
 *   tsx scripts/deps-check.ts               # reads cdk-outputs.dev.json
 *   AWS_PROFILE=gdp-dev npm run check:deps
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv, env, exit } from 'node:process';
import type { SelfCheckReport } from '../src/ops/selfCheck.js';

const ICON = {
  ok: '\x1b[32m✓\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✗\x1b[0m',
  skipped: '\x1b[2m–\x1b[0m',
};
const EMOJI = { ok: '✅', warn: '⚠️', fail: '❌', skipped: '➖' };

function functionName(): string {
  if (argv[2]) return argv[2];
  try {
    const outputs = JSON.parse(readFileSync('cdk-outputs.dev.json', 'utf-8')) as {
      GdpBackendDev?: { ApiFunctionNameOutput?: string };
    };
    const name = outputs.GdpBackendDev?.ApiFunctionNameOutput;
    if (name) return name;
  } catch {
    // fall through
  }
  console.error('Usage: tsx scripts/deps-check.ts <function-name>');
  exit(1);
}

function invoke(fn: string): SelfCheckReport {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'gdp-deps-')), 'out.json');
  const meta = JSON.parse(
    execFileSync(
      'aws',
      [
        'lambda',
        'invoke',
        '--function-name',
        fn,
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        '{"gdpSelfCheck":true}',
        '--cli-read-timeout',
        '60',
        out,
      ],
      { encoding: 'utf-8' },
    ),
  ) as { FunctionError?: string };
  const body = readFileSync(out, 'utf-8');
  if (meta.FunctionError) {
    console.error(`The Lambda threw (${meta.FunctionError}): ${body}`);
    exit(1);
  }
  return JSON.parse(body) as SelfCheckReport;
}

const inActions = env.GITHUB_ACTIONS === 'true';
const fn = functionName();
console.log(`\x1b[2mChecking dependencies of ${fn}\x1b[0m\n`);
const report = invoke(fn);

const width = Math.max(...report.checks.map((c) => c.name.length));
for (const c of report.checks) {
  console.log(`${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}  \x1b[2m${c.ms} ms\x1b[0m`);
  if (inActions && (c.status === 'fail' || c.status === 'warn')) {
    // Workflow annotations: shown on the run's summary page.
    const level = c.status === 'fail' ? 'error' : 'warning';
    console.log(`::${level} title=${c.name}::${c.detail.replace(/\r?\n/g, ' ')}`);
  }
}

if (env.GITHUB_STEP_SUMMARY) {
  const rows = report.checks.map(
    (c) => `| ${EMOJI[c.status]} | ${c.name} | ${c.detail.replace(/\|/g, '\\|')} | ${c.ms} ms |`,
  );
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      '### Dependency check',
      '',
      '| | Dependency | Result | Time |',
      '|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  );
}

if (!report.ok) {
  console.error('\n\x1b[31mA required dependency failed\x1b[0m');
  exit(1);
}
console.log('\n\x1b[32mRequired dependencies OK\x1b[0m');
