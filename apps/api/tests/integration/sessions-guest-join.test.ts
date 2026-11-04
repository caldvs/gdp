/**
 * Guests join with just a name (#183): the landing page's preview, the
 * guest's token, and what that token can and can't reach.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { createSessionTokenVerifier, type IdTokenVerifier } from '../../src/services/auth.js';
import { guestMayCall } from '../../src/middleware/auth.js';
import {
  createBillFor,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
  setPayoutFor,
} from './helpers.js';

const secret = new TextEncoder().encode('guest-join-test-secret-at-least-32-chars');
const real = createSessionTokenVerifier(secret);
// Test users sign in with `tok-<id>`; guests get real tokens from /guest-join.
const verifier: IdTokenVerifier = (token) =>
  token.startsWith('tok-') ? fakeVerifier(token) : real(token);

const buildApp = () =>
  createApp({
    idTokenVerifier: verifier,
    sessionJwtSecret: secret,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

type App = ReturnType<typeof buildApp>;

async function sharedSession(app: App, creator: string) {
  const bill = await createBillFor(app, creator);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const { sessionId } = (await create.json()) as { sessionId: string };
  await setPayoutFor(app, creator);
  const shared = await app.request(`/v1/sessions/${sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  const { joinCode } = (await shared.json()) as { joinCode: string };
  return { sessionId, joinCode, bill };
}

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('Guests join with just a name (#183)', () => {
  beforeAll(ensureBillsBucket);

  it('previews the bill for whoever has the QR, with no sign-in and no bank details', async () => {
    const app = buildApp();
    const { sessionId, joinCode, bill } = await sharedSession(app, `c-${uuidv7()}`);
    const res = await post(app, '/v1/sessions/preview', { code: joinCode });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Record<string, unknown>;
    expect(preview).toMatchObject({ sessionId, status: 'claiming', totalPence: bill.totalPence });
    expect(preview.itemCount).toBeGreaterThan(0);
    expect((preview.people as string[]).length).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(/sortCode|accountNumber|payout/);

    expect(
      (await post(app, '/v1/sessions/preview', { code: 'AbCdEfGhIjKlMnOpQrSt_-' })).status,
    ).toBe(404);
  });

  it('seats a guest with just a name and gives them a token for that bill only', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, joinCode, bill } = await sharedSession(app, creator);

    const res = await post(app, '/v1/sessions/guest-join', { code: joinCode, name: '  Tom  ' });
    expect(res.status).toBe(201);
    const { token, session } = (await res.json()) as {
      token: string;
      session: { participants: { userId: string; displayName: string }[] };
    };
    const me = session.participants.find((p) => p.displayName === 'Tom');
    expect(me?.userId).toMatch(/^guest-/);
    const auth = { authorization: `Bearer ${token}` };

    // Their own bill: read it, claim, see it again.
    expect((await app.request(`/v1/sessions/${sessionId}`, { headers: auth })).status).toBe(200);
    expect((await app.request(`/v1/bills/${bill.billId}`, { headers: auth })).status).toBe(200);
    const claim = await post(
      app,
      `/v1/sessions/${sessionId}/claims`,
      { claimedItemIds: [bill.items[1]!.itemId] },
      auth,
    );
    expect(claim.status).toBe(200);
    const meRes = await app.request('/v1/me', { headers: auth });
    expect(await meRes.json()).toMatchObject({ displayName: 'Tom', guestSessionId: sessionId });

    // Nothing else: 401 AUTH_MISSING, which doesn't sign them out of their bill.
    const refused = async (res: Response) => {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_MISSING');
    };
    await refused(await app.request('/v1/me/sessions', { headers: auth }));
    const other = await sharedSession(app, `c-${uuidv7()}`);
    await refused(await app.request(`/v1/sessions/${other.sessionId}`, { headers: auth }));
    await refused(await post(app, '/v1/sessions', { billId: bill.billId }, auth));
    await refused(await post(app, '/v1/sessions/by-code', { code: other.joinCode }, auth));
  });

  it('refuses an empty or over-long name, and a bill that is closed', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, joinCode } = await sharedSession(app, creator);
    expect(
      (await post(app, '/v1/sessions/guest-join', { code: joinCode, name: '   ' })).status,
    ).toBe(400);
    expect(
      (await post(app, '/v1/sessions/guest-join', { code: joinCode, name: 'x'.repeat(41) })).status,
    ).toBe(400);

    await app.request(`/v1/sessions/${sessionId}/abandon`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(
      (await post(app, '/v1/sessions/guest-join', { code: joinCode, name: 'Tom' })).status,
    ).toBe(404);
  });
});

describe('guestMayCall', () => {
  const sid = '01900000-0000-7000-8000-000000000000';
  it('allows the guest’s own session, its bill, its payments and /v1/me', () => {
    expect(guestMayCall('GET', '/v1/me', sid)).toBe(true);
    expect(guestMayCall('GET', `/v1/sessions/${sid}`, sid)).toBe(true);
    expect(guestMayCall('POST', `/v1/sessions/${sid}/claims`, sid)).toBe(true);
    expect(guestMayCall('GET', '/v1/bills/abc', sid)).toBe(true);
    expect(guestMayCall('GET', '/v1/payments/p1', sid)).toBe(true);
    expect(guestMayCall('POST', '/v1/payments/p1/mark-paid', sid)).toBe(true);
  });
  it('refuses everything else', () => {
    expect(guestMayCall('PUT', '/v1/me/payout-account', sid)).toBe(false);
    expect(guestMayCall('GET', '/v1/me/sessions', sid)).toBe(false);
    expect(guestMayCall('GET', '/v1/sessions/someone-else', sid)).toBe(false);
    expect(guestMayCall('GET', `/v1/sessions/${sid}x`, sid)).toBe(false);
    expect(guestMayCall('POST', '/v1/bills/reads', sid)).toBe(false);
    expect(guestMayCall('POST', '/v1/payments/p1/confirm', sid)).toBe(false);
    expect(guestMayCall('POST', '/v1/billing/table-fee', sid)).toBe(false);
  });
});
