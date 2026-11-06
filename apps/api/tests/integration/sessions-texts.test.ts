/**
 * #219/#220: texts to guests about their bill, the link in them, and the
 * receipt by email. Numbers and bank details never come back in a response.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { ConsoleSmsSender } from '../../src/services/messaging/sms.js';
import { guestPhoneStore } from '../../src/storage/guestPhoneStore.js';
import { guestTextStore } from '../../src/storage/guestTextStore.js';
import { userStore } from '../../src/storage/userStore.js';
import type { EmailSender, SendEmailInput } from '../../src/services/email/sender.js';
import {
  buildPayingSession,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
} from './helpers.js';

const PHONE = '+447700900123';

function build(sms: ConsoleSmsSender | null = new ConsoleSmsSender()) {
  const sent: SendEmailInput[] = [];
  const emailSender: EmailSender = {
    provider: 'test',
    send: (input) => {
      sent.push(input);
      return Promise.resolve();
    },
  };
  const app = createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    emailSender,
    phoneSms: sms,
  });
  return { app, sms, sent };
}

type App = ReturnType<typeof build>['app'];

const post = (app: App, path: string, who: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(who) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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

const tokenIn = (body: string) => /\/b\/([A-Za-z0-9_-]{16})/.exec(body)?.[1];

describe('#220: the paid text and the bill link', () => {
  beforeAll(ensureBillsBucket);

  it('texts the guest once when the lead marks them received, with a link to the bill', async () => {
    const { app, sms } = build();
    const { lead, guest, sessionId } = await table(app);

    const res = await post(app, `/v1/sessions/${sessionId}/participants/${guest}/received`, lead);
    expect(res.status).toBe(200);
    expect(sms!.outbox).toHaveLength(1);
    const text = sms!.outbox[0]!;
    expect(text.to).toBe(PHONE);
    expect(text.body).toMatch(/ got your £\d+\.\d\d/);
    expect(text.body).toMatch(/See the bill: \S+\/b\/[A-Za-z0-9_-]{16} \(until \d+ \w+\)$/);
    expect(text.body.length).toBeLessThanOrEqual(160);
    // Nothing in the session response says the number.
    expect(await res.text()).not.toContain('7700900123');

    // Marking again doesn't text again.
    await post(app, `/v1/sessions/${sessionId}/participants/${guest}/received`, lead);
    expect(sms!.outbox).toHaveLength(1);

    // The link: the bill, read-only, with the guest marked, no number or bank details.
    const view = await app.request(`/v1/links/${tokenIn(text.body)}`);
    expect(view.status).toBe(200);
    const raw = await view.text();
    expect(raw).not.toMatch(/7700900123|sortCode|accountNumber|payout|monzo|revolut/i);
    const body = JSON.parse(raw) as {
      sessionId: string;
      leadName: string;
      diners: { displayName: string; isYou: boolean; isLead: boolean; paid: { kind: string } }[];
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.leadName).toBe(lead);
    const you = body.diners.find((d) => d.isYou)!;
    expect(you.isLead).toBe(false);
    expect(you.paid.kind).toBe('paid');
    expect(raw).not.toContain('"userId"');
  });

  it('a guest with no number gets no text; the lead still marks them received', async () => {
    const { app, sms } = build();
    const lead = `c-${randomUUID()}`;
    const guest = `g-${randomUUID()}`;
    const { sessionId } = await buildPayingSession(app, lead, [guest]);
    const res = await post(app, `/v1/sessions/${sessionId}/participants/${guest}/received`, lead);
    expect(res.status).toBe(200);
    expect(sms!.outbox).toHaveLength(0);
  });

  it('no texts where SMS is off', async () => {
    const { app } = build(null);
    const { lead, guest, sessionId } = await table(app);
    const res = await post(app, `/v1/sessions/${sessionId}/participants/${guest}/received`, lead);
    expect(res.status).toBe(200);
    expect((await guestTextStore.get(sessionId, guest)).paidSentAt).toBeUndefined();
  });

  it('an unknown or malformed link is gone', async () => {
    const { app } = build();
    expect((await app.request('/v1/links/AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await app.request('/v1/links/short')).status).toBe(404);
  });

  it('a link past its 30 days is gone', async () => {
    const { app } = build();
    const { guest, sessionId } = await table(app);
    const { token } = await guestTextStore.link(sessionId, guest);
    expect((await app.request(`/v1/links/${token}`)).status).toBe(200);
    // Age the link row.
    const { ddb, TABLE_NAME } = await import('../../src/storage/ddb.js');
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `BLINK#${token}`, sk: 'BLINK' },
        UpdateExpression: 'SET ttlAt = :past',
        ExpressionAttributeValues: { ':past': Math.floor(Date.now() / 1000) - 1 },
      }),
    );
    expect((await app.request(`/v1/links/${token}`)).status).toBe(404);
  });

  it('emails a guest their receipt, a few times at most, never to the lead', async () => {
    const { app, sent } = build();
    const { lead, guest, sessionId } = await table(app);
    const tom = `tom-${randomUUID().slice(0, 8)}@example.com`;
    const res = await post(app, `/v1/sessions/${sessionId}/receipt`, guest, {
      email: tom.toUpperCase(),
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(tom);
    expect(sent[0]!.category).toBe('receipt');
    expect(sent[0]!.body.text).toContain('You had');
    expect(sent[0]!.body.text).not.toMatch(/sortCode|accountNumber/i);

    await post(app, `/v1/sessions/${sessionId}/receipt`, guest, { email: tom });
    await post(app, `/v1/sessions/${sessionId}/receipt`, guest, { email: tom });
    const fourth = await post(app, `/v1/sessions/${sessionId}/receipt`, guest, {
      email: tom,
    });
    expect(fourth.status).toBe(429);
    expect(sent).toHaveLength(3);

    expect(
      (await post(app, `/v1/sessions/${sessionId}/receipt`, lead, { email: 'x@example.com' }))
        .status,
    ).toBe(400);
    expect(
      (await post(app, `/v1/sessions/${sessionId}/receipt`, guest, { email: 'not-an-email' }))
        .status,
    ).toBe(400);
  });
});
