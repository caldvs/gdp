import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
import { createApp } from '../../src/app.js';
import { userStore } from '../../src/storage/userStore.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import type { EmailSender, SendEmailInput } from '../../src/services/email/sender.js';
import {
  buildPayingSession,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  sampleParsedBill,
} from './helpers.js';
import { createReportService } from '../../src/services/sessions/reportService.js';
import { runLeadEmails } from '../../src/ops/leadEmails.js';
import { leadMailQueue, type QueuedLeadMail } from '../../src/storage/leadMailQueue.js';

const capture = () => {
  const sent: SendEmailInput[] = [];
  const emailSender: EmailSender = {
    provider: 'test',
    send: (input) => {
      sent.push(input);
      return Promise.resolve();
    },
  };
  return { sent, emailSender };
};

const buildApp = (emailSender: EmailSender) =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    emailSender,
  });

const withEmail = (userId: string, name: string) =>
  userStore.putProfile({ userId, email: `${userId}@example.com`, displayName: name });

describe('bill reports', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('#221: settling emails nobody; the next morning the lead gets how it ended', async () => {
    const { sent, emailSender } = capture();
    const app = buildApp(emailSender);
    const lead = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    await withEmail(lead, 'Lead');
    await withEmail(guest, 'Guest');
    const { sessionId } = await buildPayingSession(app, lead, [guest]);

    const res = await app.request(`/v1/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: makeAuth(lead),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);

    // Only this test's row: the queue is one partition shared by every test.
    const mine = {
      due: async (before: string) =>
        (await leadMailQueue.due(before)).filter((q) => q.sessionId === sessionId),
      remove: (q: QueuedLeadMail) => leadMailQueue.remove(q),
    };
    const reports = createReportService({ emailSender, appBaseUrl: 'https://test.paymeback.dev' });
    const send = (id: string) => reports.sendLeadEmail(id);

    // Same day: not due yet.
    expect((await runLeadEmails({ queue: mine, send })).due).toBe(0);

    const tomorrow = () => new Date(Date.now() + 36 * 3600_000);
    const done = await runLeadEmails({ queue: mine, send, now: tomorrow });
    expect(done).toMatchObject({ due: 1, sent: 1, failed: [] });
    expect(sent.map((m) => m.to)).toEqual([`${lead}@example.com`]);
    expect(sent[0]!.category).toBe('lead-settled');
    expect(sent[0]!.subject).toMatch(/^Your bill summary (for .+ )?is ready$/);
    expect(sent[0]!.body.text).toContain(`https://test.paymeback.dev/session/${sessionId}`);

    // Sent once: the row is gone.
    expect((await runLeadEmails({ queue: mine, send, now: tomorrow })).due).toBe(0);
  });

  it('emails only the caller when asked, while the bill is open', async () => {
    const { sent, emailSender } = capture();
    const app = buildApp(emailSender);
    const lead = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    await withEmail(lead, 'Lead');
    await withEmail(guest, 'Guest');
    const { sessionId } = await buildPayingSession(app, lead, [guest]);

    const res = await app.request(`/v1/sessions/${sessionId}/report`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(202);
    expect(sent.map((m) => m.to)).toEqual([`${guest}@example.com`]);
    expect(sent[0]!.body.text).toContain('You had');
    expect(sent[0]!.body.text).toContain('Still open');
  });

  it("doesn't email someone who isn't on the bill", async () => {
    const { sent, emailSender } = capture();
    const app = buildApp(emailSender);
    const lead = `c-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    await withEmail(stranger, 'Stranger');
    const { sessionId } = await buildPayingSession(app, lead, [`g-${uuidv7()}`]);

    const res = await app.request(`/v1/sessions/${sessionId}/report`, {
      method: 'POST',
      headers: makeAuth(stranger),
    });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
