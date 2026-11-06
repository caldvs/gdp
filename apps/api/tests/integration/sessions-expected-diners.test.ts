/**
 * #64: the lead says how many people are eating, shown as "3 of 4 joined".
 * Display only: it never touches what anyone owes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
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

async function newSession(app: App, lead: string, extra: Record<string, unknown> = {}) {
  const bill = await createBillFor(app, lead);
  const res = await send(app, 'POST', '/v1/sessions', lead, { billId: bill.billId, ...extra });
  return { res, session: (await res.json()) as Session };
}

describe('expected party size (#64)', () => {
  beforeAll(ensureBillsBucket);

  it('is unset by default', async () => {
    const app = buildApp();
    const { res, session } = await newSession(app, `u-${uuidv7()}`);
    expect(res.status).toBe(201);
    expect(session.expectedDiners).toBeUndefined();
  });

  it('can be sent with create, and survives sharing', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead, { expectedDiners: 4 });
    expect(session.expectedDiners).toBe(4);
    await send(app, 'POST', `/v1/sessions/${session.sessionId}/share`, lead);
    const got = await send(app, 'GET', `/v1/sessions/${session.sessionId}`, lead);
    const after = (await got.json()) as Session;
    expect(after.status).toBe('claiming');
    expect(after.expectedDiners).toBe(4);
  });

  it.each([1, 100, 2.5, '4'])('create rejects %s', async (n) => {
    const app = buildApp();
    const { res } = await newSession(app, `u-${uuidv7()}`, { expectedDiners: n });
    expect(res.status).toBe(400);
  });

  it('the lead can set, change and clear it; guests see it', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const guest = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}`;
    await send(app, 'POST', `${path}/share`, lead);
    await send(app, 'POST', `${path}/join`, guest);

    for (const n of [2, 10, 5]) {
      const res = await send(app, 'PATCH', path, lead, { expectedDiners: n });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Session).expectedDiners).toBe(n);
    }
    const seen = (await (await send(app, 'GET', path, guest)).json()) as Session;
    expect(seen.expectedDiners).toBe(5);
    expect(seen.participants).toHaveLength(2);

    const cleared = await send(app, 'PATCH', path, lead, { expectedDiners: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Session).expectedDiners).toBeUndefined();
    const reread = (await (await send(app, 'GET', path, lead)).json()) as Session;
    expect(reread.expectedDiners).toBeUndefined();
  });

  it.each([1, 100, 3.5])('update rejects %s', async (n) => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead);
    const res = await send(app, 'PATCH', `/v1/sessions/${session.sessionId}`, lead, {
      expectedDiners: n,
    });
    expect(res.status).toBe(400);
  });

  it('update needs a body with only expectedDiners', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}`;
    expect((await send(app, 'PATCH', path, lead, {})).status).toBe(400);
    expect((await send(app, 'PATCH', path, lead, { expectedDiners: 3, status: 'x' })).status).toBe(
      400,
    );
  });

  it('only the lead can change it', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const guest = `u-${uuidv7()}`;
    const stranger = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead);
    const path = `/v1/sessions/${session.sessionId}`;
    await send(app, 'POST', `${path}/share`, lead);
    await send(app, 'POST', `${path}/join`, guest);
    expect((await send(app, 'PATCH', path, guest, { expectedDiners: 3 })).status).toBe(404);
    expect((await send(app, 'PATCH', path, stranger, { expectedDiners: 3 })).status).toBe(404);
    expect(
      (await send(app, 'PATCH', `/v1/sessions/${uuidv7()}`, lead, { expectedDiners: 3 })).status,
    ).toBe(404);
  });

  it('is locked once the bill is deleted', async () => {
    const app = buildApp();
    const lead = `u-${uuidv7()}`;
    const { session } = await newSession(app, lead, { expectedDiners: 3 });
    const path = `/v1/sessions/${session.sessionId}`;
    await send(app, 'POST', `${path}/abandon`, lead);
    const res = await send(app, 'PATCH', path, lead, { expectedDiners: 4 });
    expect(res.status).toBe(409);
  });
});
