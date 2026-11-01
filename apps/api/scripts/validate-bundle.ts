/* eslint-disable no-console -- CLI script, console is the whole point */

/**
 * Pre-deploy bundle validator.
 *
 * Runs `cdk synth GdpBackendDev`, finds the bundled Lambda asset CDK
 * produced, loads it in this Node process with realistic env vars,
 * and invokes the handler against fake API Gateway v2 events.
 *
 * Catches the bug classes that previously only showed up against deployed
 * AWS:
 *   - module-load failures (e.g. NODE_ENV mismatched against zod schema,
 *     pino's `require('node:os')` under ESM)
 *   - missing bundled assets (e.g. openapi.yaml not copied alongside
 *     index.mjs by the afterBundling commandHook)
 *
 * What it does NOT catch:
 *   - CFN dynamic-reference resolution (Secrets Manager / SSM lookup
 *     happens server-side at deploy time)
 *   - IAM permission issues at runtime
 *   - Real network calls to DDB/S3/Gemini/TrueLayer
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function fail(msg: string): never {
  console.error(`${RED}✗ ${msg}${RESET}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function findApiAssetDir(): string {
  if (!existsSync('cdk.out')) fail('cdk.out missing — synth did not produce output');

  const candidates = readdirSync('cdk.out')
    .filter((name) => name.startsWith('asset.'))
    .map((name) => join('cdk.out', name))
    .filter((dir) => statSync(dir).isDirectory());

  // The API handler asset is the one with both index.mjs (the bundle) and
  // openapi.yaml (copied by the afterBundling commandHook). Other assets
  // — the s3-autodelete custom-resource Lambda, the standalone
  // openapi.yaml asset — won't have both.
  const matches = candidates.filter(
    (dir) => existsSync(join(dir, 'index.mjs')) && existsSync(join(dir, 'openapi.yaml')),
  );

  if (matches.length === 0) {
    fail(
      'No asset directory contains both index.mjs and openapi.yaml. ' +
        'Either CDK bundling failed or the afterBundling commandHook did not run.',
    );
  }
  if (matches.length > 1) {
    // Shouldn't happen for a single API Lambda, but pick the most recent.
    matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  }
  return matches[0]!;
}

function setLambdaEnv(): void {
  // Mirror the values CDK ships in the GdpBackendDev Lambda env block —
  // not the actual secret values, but plausible strings so the runtime
  // env-validation passes and the handler runs without contacting AWS.
  const envValues: Record<string, string> = {
    NODE_ENV: 'production',
    APP_ENV: 'dev',
    AWS_REGION: 'eu-west-2',
    AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    DDB_TABLE_NAME: 'gdp-validator',
    S3_BUCKET_BILLS: 'gdp-bills-validator',
    LOG_LEVEL: 'silent',
    SESSION_JWT_SECRET: 'validator-fake-session-jwt-secret-32-bytes-long',
    GEMINI_API_KEY: 'validator-fake-gemini-key',
    TRUELAYER_CLIENT_ID: 'validator-fake-tl-client',
    TRUELAYER_CLIENT_SECRET: 'validator-fake-tl-secret',
    TRUELAYER_WEBHOOK_SECRET: 'validator-fake-webhook-secret',
    TRUELAYER_ENVIRONMENT: 'sandbox',
  };
  for (const [k, v] of Object.entries(envValues)) {
    process.env[k] = v;
  }
}

function makeEvent(method: string, path: string, headers: Record<string, string> = {}): unknown {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'validator.local', ...headers },
    requestContext: {
      accountId: '000000000000',
      apiId: 'validator',
      domainName: 'validator.local',
      domainPrefix: 'validator',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'validate-bundle',
      },
      requestId: 'validate-1',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  };
}

interface LambdaResponse {
  statusCode?: number;
  body?: string;
}

async function invoke(handler: unknown, event: unknown): Promise<LambdaResponse> {
  if (typeof handler !== 'function') {
    fail('handler exported from index.mjs is not a function');
  }
  const result = await (handler as (e: unknown, ctx: unknown) => Promise<LambdaResponse>)(
    event,
    {},
  );
  return result;
}

async function main(): Promise<void> {
  console.log(`${DIM}Synthesising GdpBackendDev...${RESET}`);
  try {
    execSync('npx cdk synth GdpBackendDev', { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    fail('cdk synth GdpBackendDev failed');
  }
  pass('cdk synth GdpBackendDev');

  const assetDir = findApiAssetDir();
  pass(`Found API Lambda asset: ${DIM}${assetDir}${RESET}`);

  setLambdaEnv();

  const indexUrl = pathToFileURL(join(assetDir, 'index.mjs')).href;
  let mod: { handler?: unknown };
  try {
    mod = (await import(indexUrl)) as { handler?: unknown };
  } catch (err) {
    fail(`Bundle failed to load: ${(err as Error).message}`);
  }
  pass('Bundle imports cleanly under realistic env vars');

  // GET /healthz → 200 {status:ok}
  {
    const res = await invoke(mod.handler, makeEvent('GET', '/healthz'));
    if (res.statusCode !== 200) {
      fail(`/healthz: expected statusCode 200, got ${res.statusCode}`);
    }
    const body = JSON.parse(res.body ?? '{}') as { status?: string };
    if (body.status !== 'ok') {
      fail(`/healthz: expected {status:'ok'}, got ${JSON.stringify(body)}`);
    }
    pass('Handler invocation: GET /healthz → 200 {status:ok}');
  }

  // GET /v1/me (no auth) → 401 AUTH_MISSING
  {
    const res = await invoke(mod.handler, makeEvent('GET', '/v1/me'));
    if (res.statusCode !== 401) {
      fail(`/v1/me unauthed: expected 401, got ${res.statusCode}`);
    }
    const body = JSON.parse(res.body ?? '{}') as { error?: { code?: string } };
    if (body.error?.code !== 'AUTH_MISSING') {
      fail(`/v1/me unauthed: expected AUTH_MISSING, got ${body.error?.code}`);
    }
    pass('Handler invocation: GET /v1/me (unauthed) → 401 AUTH_MISSING');
  }

  // GET /docs → 200 (proves openapi.yaml is bundled alongside index.mjs)
  {
    const res = await invoke(mod.handler, makeEvent('GET', '/docs'));
    if (res.statusCode !== 200) {
      fail(`/docs: expected 200, got ${res.statusCode} — openapi.yaml may not be bundled`);
    }
    if (!res.body?.includes('<redoc')) {
      fail('/docs: response body does not include the Redoc tag');
    }
    pass('Handler invocation: GET /docs → 200 (openapi.yaml is bundled)');
  }

  console.log(`\n${GREEN}Bundle validation passed${RESET}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
