import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import {
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  uniqueImageBytes,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

async function createBill(app: ReturnType<typeof buildApp>, userId: string) {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: uniqueImageBytes(),
      ContentType: 'image/jpeg',
    }),
  );
  const res = await app.request('/v1/bills/parse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      ...makeAuth(userId),
    },
    body: JSON.stringify({ uploadId }),
  });
  return (await res.json()) as { billId: string; items: { itemId: string }[] };
}

describe('POST /v1/sessions and /v1/sessions/:id/share', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('creates a session in setup with creator as the only participant; join code hidden', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);

    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as {
      sessionId: string;
      status: string;
      creatorUserId: string;
      collectorUserId: string;
      billId: string;
      pinnedBillVersion: number;
      joinCode?: string;
      participants: { userId: string; avatarUrl?: string; payment: { status: string } }[];
    };
    expect(session.status).toBe('setup');
    expect(session.creatorUserId).toBe(creator);
    expect(session.collectorUserId).toBe(creator);
    expect(session.billId).toBe(bill.billId);
    expect(session.pinnedBillVersion).toBe(1);
    expect(session.joinCode).toBeUndefined(); // hidden in setup, visible after /share
    expect(session.participants).toHaveLength(1);
    expect(session.participants[0]?.userId).toBe(creator);
    expect(session.participants[0]?.payment.status).toBe('unpaid');
    // fakeVerifier returns picture for tok-<userId>; sessionService should
    // plumb that into Participant.avatarUrl.
    expect(session.participants[0]?.avatarUrl).toBe(`https://avatar.example/${creator}.png`);
  });

  it("rejects creating a session for someone else's bill (BILL_NOT_FOUND)", async () => {
    const app = buildApp();
    const owner = `o-${uuidv7()}`;
    const interloper = `x-${uuidv7()}`;
    const bill = await createBill(app, owner);

    const res = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(interloper) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BILL_NOT_FOUND');
  });

  it('share transitions setup → claiming, freezes creator, marks self_paid', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);

    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    // creator claims their items in setup first
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: [bill.items[0]?.itemId] }),
    });

    const share = await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(share.status).toBe(200);
    const after = (await share.json()) as {
      status: string;
      joinCode?: string;
      participants: { userId: string; payment: { status: string } }[];
    };
    expect(after.status).toBe('claiming');
    expect(after.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const creatorPart = after.participants.find((p) => p.userId === creator);
    expect(creatorPart?.payment.status).toBe('self_paid');
  });

  it('non-creator cannot share', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const interloper = `x-${uuidv7()}`;
    const bill = await createBill(app, creator);

    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    const res = await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(interloper),
    });
    expect(res.status).toBe(404);
  });

  it('amending a bill is rejected once a session has been created from it (any state)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    // Session is in setup. Bill should already be locked.
    const amend = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: [{ name: 'changed', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amend.status).toBe(409);
    const body = (await amend.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('cannot create a second session for the same bill while the first is active', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const first = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('a stranger cannot read a session they are not part of (404)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    const res = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(stranger),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('cannot share twice (state must be setup)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    const second = await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });
});
