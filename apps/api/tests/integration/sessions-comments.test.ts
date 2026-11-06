/**
 * #218: each bill has a comments thread. Anyone at the table reads and
 * writes; text only; nobody else can see it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
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
  createApp({ idTokenVerifier: fakeVerifier, billParser: new FixtureBillParser(sampleParsedBill) });
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

async function table(app: App) {
  const lead = `u-${uuidv7()}`;
  const sam = `u-${uuidv7()}`;
  const bill = await createBillFor(app, lead);
  const s = (await (
    await send(app, 'POST', '/v1/sessions', lead, { billId: bill.billId })
  ).json()) as Session;
  await send(app, 'POST', `/v1/sessions/${s.sessionId}/share`, lead);
  expect((await send(app, 'POST', `/v1/sessions/${s.sessionId}/join`, sam)).status).toBe(200);
  return { lead, sam, sessionId: s.sessionId };
}

describe('comments (#218)', () => {
  beforeAll(ensureBillsBucket);

  it('a guest writes, the lead reads it, oldest first, trimmed', async () => {
    const app = buildApp();
    const { lead, sam, sessionId } = await table(app);
    const path = `/v1/sessions/${sessionId}/comments`;
    expect(await (await send(app, 'GET', path, lead)).json()).toEqual({ comments: [] });

    const posted = await send(app, 'POST', path, sam, { text: '  Sent mine by Monzo  ' });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ userId: sam, text: 'Sent mine by Monzo' });
    await send(app, 'POST', path, lead, { text: 'Got it, thanks' });

    const { comments } = (await (await send(app, 'GET', path, lead)).json()) as {
      comments: Array<{ userId: string; text: string }>;
    };
    expect(comments.map((c) => [c.userId, c.text])).toEqual([
      [sam, 'Sent mine by Monzo'],
      [lead, 'Got it, thanks'],
    ]);
    // Comments don't change the session itself.
    const got = await send(app, 'GET', `/v1/sessions/${sessionId}`, lead);
    expect(got.status).toBe(200);
  });

  it('empty or too long is refused', async () => {
    const app = buildApp();
    const { sam, sessionId } = await table(app);
    const path = `/v1/sessions/${sessionId}/comments`;
    expect((await send(app, 'POST', path, sam, { text: '   ' })).status).toBe(400);
    expect((await send(app, 'POST', path, sam, { text: 'x'.repeat(281) })).status).toBe(400);
    expect((await send(app, 'POST', path, sam, { text: 'x'.repeat(280) })).status).toBe(201);
  });

  it('someone not at the table sees nothing and can’t write', async () => {
    const app = buildApp();
    const { sessionId } = await table(app);
    const stranger = `u-${uuidv7()}`;
    const path = `/v1/sessions/${sessionId}/comments`;
    expect((await send(app, 'GET', path, stranger)).status).toBe(404);
    expect((await send(app, 'POST', path, stranger, { text: 'hi' })).status).toBe(404);
  });

  it('30 an hour per person, then 429', async () => {
    const app = buildApp();
    const { sam, sessionId } = await table(app);
    const path = `/v1/sessions/${sessionId}/comments`;
    for (let i = 0; i < 30; i++) {
      expect((await send(app, 'POST', path, sam, { text: `n${i}` })).status).toBe(201);
    }
    expect((await send(app, 'POST', path, sam, { text: 'one more' })).status).toBe(429);
  });

  it('a deleted bill takes no more comments', async () => {
    const app = buildApp();
    const { lead, sessionId } = await table(app);
    expect((await send(app, 'POST', `/v1/sessions/${sessionId}/abandon`, lead)).status).toBe(200);
    expect(
      (await send(app, 'POST', `/v1/sessions/${sessionId}/comments`, lead, { text: 'hi' })).status,
    ).toBe(409);
  });
});
