/* eslint-disable no-console -- CLI script, console is the whole point */

/**
 * Post-deploy smoke test.
 *
 * Asserts the deployed API is actually serving traffic and the auth
 * boundary is wired. Run after every `cdk deploy`.
 *
 * Usage:
 *   tsx scripts/smoke.ts <api-url>
 *   tsx scripts/smoke.ts                 # falls back to cdk-outputs.dev.json
 */
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function fail(msg: string): never {
  console.error(`${RED}✗ ${msg}${RESET}`);
  exit(1);
}

function pass(msg: string): void {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function getApiUrl(): string {
  const arg = argv[2];
  if (arg) return arg.replace(/\/$/, '');

  try {
    const outputs = JSON.parse(readFileSync('cdk-outputs.dev.json', 'utf-8')) as {
      GdpBackendDev?: { ApiUrlOutput?: string };
    };
    const url = outputs.GdpBackendDev?.ApiUrlOutput;
    if (url) return url.replace(/\/$/, '');
  } catch {
    // fall through
  }

  fail(
    'Usage: tsx scripts/smoke.ts <api-url>  (or run after `cdk deploy --outputs-file cdk-outputs.dev.json`)',
  );
}

async function checkHealthz(api: string): Promise<void> {
  const res = await fetch(`${api}/healthz`);
  if (res.status !== 200) fail(`/healthz: expected 200, got ${res.status}`);
  const body = (await res.json()) as { status?: string };
  if (body.status !== 'ok') {
    fail(`/healthz: expected {status:'ok'}, got ${JSON.stringify(body)}`);
  }
  pass('/healthz → 200 {status:ok}');
}

async function checkReadyz(api: string): Promise<void> {
  const res = await fetch(`${api}/readyz`);
  if (res.status !== 200) fail(`/readyz: expected 200, got ${res.status}`);
  const body = (await res.json()) as {
    status?: string;
    checks?: { ddb?: string; s3?: string };
  };
  if (body.checks?.ddb !== 'ok') fail(`/readyz: ddb check is ${body.checks?.ddb}`);
  if (body.checks?.s3 !== 'ok') fail(`/readyz: s3 check is ${body.checks?.s3}`);
  pass('/readyz → 200 checks {ddb:ok, s3:ok}');
}

async function checkAuthGate(api: string): Promise<void> {
  const res = await fetch(`${api}/v1/me`);
  if (res.status !== 401) fail(`/v1/me unauthed: expected 401, got ${res.status}`);
  const body = (await res.json()) as { error?: { code?: string; requestId?: string } };
  if (body.error?.code !== 'AUTH_MISSING') {
    fail(`/v1/me unauthed: expected AUTH_MISSING, got ${body.error?.code}`);
  }
  if (!body.error.requestId) {
    fail('/v1/me unauthed: error envelope missing requestId');
  }
  pass('/v1/me (unauthed) → 401 AUTH_MISSING with requestId');
}

async function checkRequestIdHeader(api: string): Promise<void> {
  const res = await fetch(`${api}/healthz`);
  const id = res.headers.get('x-request-id');
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) {
    fail(`/healthz response missing X-Request-Id header (got ${id ?? 'null'})`);
  }
  pass(`/healthz response carries X-Request-Id: ${DIM}${id}${RESET}`);
}

async function main(): Promise<void> {
  const api = getApiUrl();
  console.log(`${DIM}Smoking ${api}${RESET}\n`);

  await checkHealthz(api);
  await checkReadyz(api);
  await checkAuthGate(api);
  await checkRequestIdHeader(api);

  console.log(`\n${GREEN}All smoke checks passed${RESET}`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
