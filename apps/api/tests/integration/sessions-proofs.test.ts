/**
 * #226: a guest sends a cropped screenshot of their payment; only the lead
 * (and the guest) can see it; the guest can remove it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import { proofKey } from '../../src/storage/proofStore.js';
import type { Session } from '../../src/types/sessions.js';
import type { EmailSender, SendEmailInput } from '../../src/services/email/sender.js';
import { userStore } from '../../src/storage/userStore.js';
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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

async function upload(app: App, sessionId: string, user: string) {
  const res = await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, user, {
    sizeBytes: JPEG.length,
  });
  expect(res.status).toBe(201);
  const slot = (await res.json()) as { proofId: string; url: string };
  const put = await fetch(slot.url, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: JPEG,
  });
  expect(put.status).toBe(200);
  return slot.proofId;
}

describe('proof of payment (#226)', () => {
  it('#221: the lead is emailed once, with a link and no image', async () => {
    const sent: SendEmailInput[] = [];
    const emailSender: EmailSender = {
      provider: 'test',
      send: (m) => {
        sent.push(m);
        return Promise.resolve();
      },
    };
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
      emailSender,
    });
    const { lead, sam, sessionId } = await table(app);
    await userStore.putProfile({ userId: lead, email: `${lead}@example.com`, displayName: 'Lead' });
    const proofId = await upload(app, sessionId, sam);
    const path = `/v1/sessions/${sessionId}/proofs/${proofId}/sent`;
    expect((await send(app, 'POST', path, sam)).status).toBe(200);
    expect((await send(app, 'POST', path, sam)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: `${lead}@example.com`, category: 'proof' });
    expect(sent[0]!.subject).toMatch(/sent a screenshot of their payment/);
    expect(sent[0]!.body.html).toContain(`/session/${sessionId}`);
    expect(sent[0]!.body.html).not.toMatch(/<img|proofs\//);
  });

  beforeAll(ensureBillsBucket);

  it('a guest uploads, confirms, and the lead sees it; strangers don’t', async () => {
    const app = buildApp();
    const { lead, sam, sessionId } = await table(app);
    const proofId = await upload(app, sessionId, sam);

    // Not confirmed yet: the lead sees nothing.
    let list = (await (
      await send(app, 'GET', `/v1/sessions/${sessionId}/proofs`, lead)
    ).json()) as { proofs: unknown[] };
    expect(list.proofs).toEqual([]);

    const sent = await send(app, 'POST', `/v1/sessions/${sessionId}/proofs/${proofId}/sent`, sam);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ proofId, userId: sam });

    list = (await (await send(app, 'GET', `/v1/sessions/${sessionId}/proofs`, lead)).json()) as {
      proofs: Array<{ proofId: string; userId: string; url: string }>;
    };
    expect(list.proofs).toHaveLength(1);
    expect(list.proofs[0]).toMatchObject({ proofId, userId: sam });
    const got = await fetch((list.proofs[0] as { url: string }).url);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG);

    const stranger = `u-${uuidv7()}`;
    expect((await send(app, 'GET', `/v1/sessions/${sessionId}/proofs`, stranger)).status).toBe(404);
  });

  it('the lead can’t upload; too big is refused; at most 3 each', async () => {
    const app = buildApp();
    const { lead, sam, sessionId } = await table(app);
    expect(
      (await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, lead, { sizeBytes: 10 })).status,
    ).toBe(404);
    expect(
      (
        await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, sam, {
          sizeBytes: 2 * 1024 * 1024 + 1,
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 3; i++) {
      expect(
        (await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, sam, { sizeBytes: 10 }))
          .status,
      ).toBe(201);
    }
    expect(
      (await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, sam, { sizeBytes: 10 })).status,
    ).toBe(429);
  });

  it('confirming before the upload lands is refused', async () => {
    const app = buildApp();
    const { sam, sessionId } = await table(app);
    const res = await send(app, 'POST', `/v1/sessions/${sessionId}/proofs`, sam, { sizeBytes: 10 });
    const { proofId } = (await res.json()) as { proofId: string };
    expect(
      (await send(app, 'POST', `/v1/sessions/${sessionId}/proofs/${proofId}/sent`, sam)).status,
    ).toBe(409);
  });

  it('the guest removes it: the row and the image go', async () => {
    const app = buildApp();
    const { lead, sam, sessionId } = await table(app);
    const proofId = await upload(app, sessionId, sam);
    await send(app, 'POST', `/v1/sessions/${sessionId}/proofs/${proofId}/sent`, sam);
    // Only the guest who sent it can remove it.
    expect(
      (await send(app, 'DELETE', `/v1/sessions/${sessionId}/proofs/${proofId}`, lead)).status,
    ).toBe(404);
    expect(
      (await send(app, 'DELETE', `/v1/sessions/${sessionId}/proofs/${proofId}`, sam)).status,
    ).toBe(204);
    const list = (await (
      await send(app, 'GET', `/v1/sessions/${sessionId}/proofs`, lead)
    ).json()) as { proofs: unknown[] };
    expect(list.proofs).toEqual([]);
    await expect(
      s3.send(
        new HeadObjectCommand({ Bucket: BILLS_BUCKET, Key: proofKey(sessionId, sam, proofId) }),
      ),
    ).rejects.toBeTruthy();
  });
});
