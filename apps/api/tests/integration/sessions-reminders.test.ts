/**
 * #219: reminder texts. The lead's *Remind* (once a day, three in all), the
 * opt-out link, and the one automatic reminder a day after payments open.
 * Numbers never come back in a response.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { ConsoleSmsSender } from '../../src/services/messaging/sms.js';
import { createGuestTexts } from '../../src/services/sessions/guestTexts.js';
import { runReminders } from '../../src/ops/reminders.js';
import { ddb, TABLE_NAME } from '../../src/storage/ddb.js';
import { guestPhoneStore } from '../../src/storage/guestPhoneStore.js';
import { guestTextStore } from '../../src/storage/guestTextStore.js';
import { reminderQueue } from '../../src/storage/reminderQueue.js';
import { userStore } from '../../src/storage/userStore.js';
import {
  buildPayingSession,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
} from './helpers.js';

const PHONE = '+447700900123';
const DIGITS = '7700900123';

function build(sms: ConsoleSmsSender | null = new ConsoleSmsSender()) {
  const app = createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    emailSender: { provider: 'test', send: () => Promise.resolve() },
    phoneSms: sms,
  });
  return { app, sms };
}

type App = ReturnType<typeof build>['app'];

const post = (app: App, path: string, who: string) =>
  app.request(path, { method: 'POST', headers: makeAuth(who) });
const get = (app: App, path: string, who: string) => app.request(path, { headers: makeAuth(who) });
const remind = (app: App, sessionId: string, guest: string, who: string) =>
  post(app, `/v1/sessions/${sessionId}/participants/${guest}/remind`, who);

async function table(app: App) {
  const lead = `c-${randomUUID()}`;
  const guest = `g-${randomUUID()}`;
  await userStore.putProfile({
    userId: lead,
    email: `${lead}@example.com`,
    displayName: 'Callum Davies',
  });
  const { sessionId } = await buildPayingSession(app, lead, [guest]);
  await guestPhoneStore.put(sessionId, guest, PHONE);
  return { lead, guest, sessionId };
}

/** A day passes since the last reminder. */
const aDayLater = (sessionId: string, userId: string) =>
  ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `SESS#${sessionId}`, sk: `GUESTTEXT#${userId}` },
      UpdateExpression: 'SET lastReminderAt = :t',
      ExpressionAttributeValues: { ':t': '2000-01-01T00:00:00.000Z' },
    }),
  );

const tokenIn = (body: string) => /\/s\/([A-Za-z0-9_-]{16})$/.exec(body)?.[1];

describe('#219: reminders', () => {
  beforeAll(ensureBillsBucket);

  it('the lead reminds a guest: one text, once a day, and nothing gives the number away', async () => {
    const { app, sms } = build();
    const { lead, guest, sessionId } = await table(app);

    const states = await get(app, `/v1/sessions/${sessionId}/texts`, lead);
    expect(states.status).toBe(200);
    const raw = await states.text();
    expect(raw).not.toContain(DIGITS);
    expect(JSON.parse(raw)).toMatchObject({
      enabled: true,
      guests: { [guest]: { remind: 'ready', reminders: 0 } },
    });

    const res = await remind(app, sessionId, guest, lead);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(DIGITS);
    expect(JSON.parse(body)).toMatchObject({ remind: 'today', reminders: 1 });
    expect(sms!.outbox).toHaveLength(1);
    const text = sms!.outbox[0]!;
    expect(text.to).toBe(PHONE);
    expect(text.body).toMatch(/^You owe \S+ £\d+\.\d\d/);
    expect(text.body).toMatch(/\/b\/[A-Za-z0-9_-]{16} Stop reminders: \S+\/s\/[A-Za-z0-9_-]{16}$/);
    expect(text.body.length).toBeLessThanOrEqual(160);

    // Once a day.
    expect((await remind(app, sessionId, guest, lead)).status).toBe(429);
    expect(sms!.outbox).toHaveLength(1);
  });

  it('three reminders in all, a day apart', async () => {
    const { app, sms } = build();
    const { lead, guest, sessionId } = await table(app);
    for (let i = 0; i < 3; i += 1) {
      expect((await remind(app, sessionId, guest, lead)).status).toBe(200);
      await aDayLater(sessionId, guest);
    }
    expect((await remind(app, sessionId, guest, lead)).status).toBe(429);
    expect(sms!.outbox).toHaveLength(3);
    const st = (await (await get(app, `/v1/sessions/${sessionId}/texts`, lead)).json()) as {
      guests: Record<string, { remind: string }>;
    };
    expect(st.guests[guest]!.remind).toBe('used_up');
  });

  it('only the lead can remind or see who can be reminded', async () => {
    const { app, sms } = build();
    const { guest, sessionId } = await table(app);
    expect((await get(app, `/v1/sessions/${sessionId}/texts`, guest)).status).toBe(404);
    expect((await remind(app, sessionId, guest, guest)).status).toBe(404);
    expect(sms!.outbox).toHaveLength(0);
  });

  it('a guest who has paid isn’t reminded', async () => {
    const { app, sms } = build();
    const { lead, guest, sessionId } = await table(app);
    await post(app, `/v1/sessions/${sessionId}/participants/${guest}/received`, lead);
    expect((await remind(app, sessionId, guest, lead)).status).toBe(409);
    expect(sms!.outbox.filter((t) => t.body.startsWith('You owe'))).toHaveLength(0);
  });

  it('where texts are off there is no Remind', async () => {
    const { app } = build(null);
    const { lead, guest, sessionId } = await table(app);
    expect(await (await get(app, `/v1/sessions/${sessionId}/texts`, lead)).json()).toEqual({
      enabled: false,
      guests: {},
    });
    expect((await remind(app, sessionId, guest, lead)).status).toBe(503);
  });

  it('the stop link ends reminders; the bill link still works', async () => {
    const { app, sms } = build();
    const { lead, guest, sessionId } = await table(app);
    await remind(app, sessionId, guest, lead);
    const token = tokenIn(sms!.outbox[0]!.body)!;
    const stop = await app.request(`/v1/links/${token}/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ stopped: true });

    await aDayLater(sessionId, guest);
    expect((await remind(app, sessionId, guest, lead)).status).toBe(409);
    const st = (await (await get(app, `/v1/sessions/${sessionId}/texts`, lead)).json()) as {
      guests: Record<string, { remind: string }>;
    };
    expect(st.guests[guest]!.remind).toBe('stopped');
    expect(sms!.outbox).toHaveLength(1);
    expect((await app.request(`/v1/links/${token}`)).status).toBe(200);
  });

  it('the automatic reminder: queued on share, sent a day after payments are seen open, once', async () => {
    const sms = new ConsoleSmsSender();
    const { app } = build(sms);
    const { guest, sessionId } = await table(app);
    expect((await reminderQueue.all()).some((q) => q.sessionId === sessionId)).toBe(true);

    let clock = new Date();
    const texts = createGuestTexts({ sms, now: () => clock });
    const queue = {
      all: async () => (await reminderQueue.all()).filter((q) => q.sessionId === sessionId),
      markOpen: (id: string, at: string) => reminderQueue.markOpen(id, at),
      remove: (id: string) => reminderQueue.remove(id),
    };
    const run = () =>
      runReminders({
        queue,
        autoRemind: (id, seen) => texts.autoRemind(id, seen),
        now: () => clock,
      });

    // Everything is claimed, so payments are open: the first run notes it.
    expect(await run()).toMatchObject({ queued: 1, opened: 1 });
    expect(sms.outbox).toHaveLength(0);
    // Too soon on a second run the same day.
    expect(await run()).toMatchObject({ queued: 1, waiting: 1 });
    // A day later: one text, and the bill leaves the queue.
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    expect(await run()).toMatchObject({ queued: 1, done: 1 });
    expect(sms.outbox).toHaveLength(1);
    expect(sms.outbox[0]!.to).toBe(PHONE);
    expect(sms.outbox[0]!.body).toMatch(/^You owe /);
    expect(await run()).toMatchObject({ queued: 0 });
    const state = await guestTextStore.get(sessionId, guest);
    expect(state.reminders).toBe(1);
    expect(state.autoReminderAt).toBeDefined();
  });
});
