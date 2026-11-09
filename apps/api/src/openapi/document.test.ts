import { readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ConsoleSmsSender } from '../services/messaging/sms.js';
import { allRoutes, openApiDocument } from './document.js';
import { renderSpec, SPEC_FILE } from './render.js';

/** Served on purpose without being in the contract. */
const UNDOCUMENTED = new Set([
  // The docs pages and the spec itself.
  'GET /docs',
  'GET /swagger',
  'GET /openapi.yaml',
  // Local only (`npm run dev:local`): sign in without an email.
  'POST /v1/auth/email/dev-sign-in',
]);

/** The app with every optional route switched on. */
function fullApp() {
  return createApp({
    sessionJwtSecret: new TextEncoder().encode('x'.repeat(32)),
    idTokenVerifier: () => Promise.reject(new Error('not used')),
    emailSender: { provider: 'test', send: () => Promise.resolve() },
    phoneSms: new ConsoleSmsSender(),
    devEmailSignIn: true,
    testAccountSignIn: true,
    stripe: {} as Stripe,
    stripeWebhookSecret: 'whsec_test',
  });
}

const served = (): string[] => {
  const keys = fullApp()
    .routes.filter((r) => r.method !== 'ALL')
    .map((r) => `${r.method} ${r.path}`);
  return [...new Set(keys)].filter((k) => !UNDOCUMENTED.has(k)).sort();
};

const documented = (): string[] =>
  allRoutes()
    .map((r) => `${r.method.toUpperCase()} ${r.path.replace(/\{(\w+)\}/g, ':$1')}`)
    .sort();

describe('the API contract (openapi.yaml)', () => {
  it('is what src/openapi generates: run `npm run gen:api` after changing it', async () => {
    expect(readFileSync(SPEC_FILE, 'utf8')).toBe(await renderSpec());
  });

  it('documents every route the app serves, and nothing it doesn’t', () => {
    expect(documented()).toEqual(served());
  });

  it('names every operation once', () => {
    const ids = allRoutes().map((r) => r.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no request body that would take bank details, except the deprecated one (ADR-0002)', () => {
    const doc = openApiDocument();
    const withBank = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { requestBody?: unknown }>)
        .filter(([, op]) =>
          /sortCode|accountNumber|PayoutAccount/.test(JSON.stringify(op.requestBody ?? '')),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(withBank).toEqual(['PUT /v1/me/payout-account']);
  });
});
