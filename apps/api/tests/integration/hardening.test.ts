/**
 * #151 and #155: join-code lookups are limited per user, the lead's
 * fingerprint of their join link's bank details, request size bounds, and
 * signing out everywhere.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import { mintSessionToken } from '../../src/services/auth/sessionToken.js';
import type { Session } from '../../src/types/sessions.js';
import {
  createBillFor,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });
type App = ReturnType<typeof buildApp>;

const send = (app: App, method: string, path: string, user: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      ...makeAuth(user),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function sharedSession(app: App, lead: string) {
  const bill = await createBillFor(app, lead);
  const res = await send(app, 'POST', '/v1/sessions', lead, { billId: bill.billId });
  const session = (await res.json()) as Session;
  const shared = await send(app, 'POST', `/v1/sessions/${session.sessionId}/share`, lead);
  return { bill, session: (await shared.json()) as Session };
}

const CHECK = 'ab'.repeat(32);

describe('join codes (#151)', () => {
  beforeAll(ensureBillsBucket);

  it('at most 30 lookups per user every 10 minutes; others are unaffected', async () => {
    const app = buildApp();
    const user = `u-${uuidv7()}`;
    let last: Response | undefined;
    for (let i = 0; i < 30; i += 1) {
      last = await send(app, 'POST', '/v1/sessions/by-code', user, { code: 'ZZZZZZ' });
      expect(last.status).toBe(404);
    }
    const refused = await send(app, 'POST', '/v1/sessions/by-code', user, { code: 'ZZZZZZ' });
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as {
      error: { code: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    const other = await send(app, 'POST', '/v1/sessions/by-code', `u-${uuidv7()}`, {
      code: 'ZZZZZZ',
    });
    expect(other.status).toBe(404);
  });
});

describe('PUT /v1/sessions/{id}/payout-check (#151)', () => {
  beforeAll(ensureBillsBucket);

  it('the lead sets it and guests see it; nobody else can set it', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const guest = `u-${uuidv7()}`;
    const { session } = await sharedSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}`;
    expect(session.payoutCheck).toBeUndefined();

    const res = await send(app, 'PUT', `${path}/payout-check`, lead, { payoutCheck: CHECK });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Session).payoutCheck).toBe(CHECK);

    await send(app, 'POST', `${path}/join`, guest);
    const seen = (await (await send(app, 'GET', path, guest)).json()) as Session;
    expect(seen.payoutCheck).toBe(CHECK);

    const other = 'cd'.repeat(32);
    expect(
      (await send(app, 'PUT', `${path}/payout-check`, guest, { payoutCheck: other })).status,
    ).toBe(404);
    const after = (await (await send(app, 'GET', path, lead)).json()) as Session;
    expect(after.payoutCheck).toBe(CHECK);
  });

  it('only a 64-hex fingerprint, never bank details', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await sharedSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}/payout-check`;
    for (const bad of [
      { payoutCheck: 'nope' },
      { payoutCheck: CHECK, sortCode: '040668' },
      { sortCode: '040668', accountNumber: '00079660' },
    ]) {
      expect((await send(app, 'PUT', path, lead, bad)).status).toBe(400);
    }
  });

  it('is refused once the bill is closed, and for an unknown bill', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await sharedSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}`;
    await send(app, 'POST', `${path}/close`, lead);
    expect(
      (await send(app, 'PUT', `${path}/payout-check`, lead, { payoutCheck: CHECK })).status,
    ).toBe(409);
    expect(
      (
        await send(app, 'PUT', `/v1/sessions/${uuidv7()}/payout-check`, lead, {
          payoutCheck: CHECK,
        })
      ).status,
    ).toBe(404);
  });
});

describe('request bounds (#155)', () => {
  beforeAll(ensureBillsBucket);

  it('amend refuses too many lines, long names and absurd amounts', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const bill = await createBillFor(app, lead);
    const item = { name: 'Chips', unitPricePence: 400, quantity: 1, category: 'food' };
    const amend = (body: Record<string, unknown>) =>
      send(app, 'POST', `/v1/bills/${bill.billId}/amend`, lead, {
        items: [item],
        taxPence: 0,
        serviceChargePence: 0,
        ...body,
      });
    expect((await amend({ items: Array.from({ length: 201 }, () => item) })).status).toBe(400);
    expect((await amend({ items: [{ ...item, name: 'x'.repeat(201) }] })).status).toBe(400);
    expect((await amend({ items: [{ ...item, quantity: 1000 }] })).status).toBe(400);
    expect((await amend({ items: [{ ...item, unitPricePence: 10_000_001 }] })).status).toBe(400);
    expect((await amend({ serviceChargePence: 10_000_001 })).status).toBe(400);
    expect((await amend({})).status).toBe(200);
  });

  it('claims refuses more than 200 ids', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await sharedSession(app, lead);
    const res = await send(app, 'POST', `/v1/sessions/${session.sessionId}/claims`, lead, {
      claimedItemIds: Array.from({ length: 201 }, () => uuidv7()),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/me/sign-out (#155)', () => {
  const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');

  it('ends every session token the user had, and later sign-ins work', async () => {
    const app = createApp({
      sessionJwtSecret: SECRET,
      idTokenVerifier: createSessionTokenVerifier(SECRET),
    });
    const userId = uuidv7();
    const mint = (tokenVersion?: number) =>
      mintSessionToken(
        {
          userId,
          email: `${userId}@example.com`,
          ...(tokenVersion !== undefined ? { tokenVersion } : {}),
        },
        SECRET,
      );
    const me = (token: string) =>
      app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
    const phone = await mint();
    const laptop = await mint();
    expect((await me(phone)).status).toBe(200);

    const out = await app.request('/v1/me/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${phone}` },
    });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });

    for (const old of [phone, laptop]) {
      const res = await me(old);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
    }
    // A token minted at the new version (the next sign-in) works.
    expect((await me(await mint(1))).status).toBe(200);
  });
});
