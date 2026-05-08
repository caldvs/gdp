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
  return (await res.json()) as {
    billId: string;
    totalPence: number;
    items: { itemId: string }[];
  };
}

async function setUpClaiming(app: ReturnType<typeof buildApp>, creator: string, guests: string[]) {
  const bill = await createBill(app, creator);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const initial = (await create.json()) as { sessionId: string };

  // creator claims item[0]
  await app.request(`/v1/sessions/${initial.sessionId}/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ claimedItemIds: [bill.items[0]?.itemId] }),
  });

  await app.request(`/v1/sessions/${initial.sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });

  for (const g of guests) {
    await app.request(`/v1/sessions/${initial.sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(g),
    });
  }
  return { sessionId: initial.sessionId, bill };
}

describe('POST /v1/sessions/:id/lock-claims', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('rejects when items remain unclaimed and reports them', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId, bill } = await setUpClaiming(app, creator, [guest]);
    // creator already claimed item[0]; nobody claims items[1] or [2]

    const res = await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { unclaimedItemIds?: string[] } };
    };
    expect(body.error.code).toBe('CLAIMS_INCOMPLETE');
    const unclaimed = body.error.details?.unclaimedItemIds ?? [];
    expect(unclaimed).toContain(bill.items[1]?.itemId);
    expect(unclaimed).toContain(bill.items[2]?.itemId);
  });

  it('non-creator cannot lock', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await setUpClaiming(app, creator, [guest]);

    const res = await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(404);
  });

  it('locks: status → paying, owedPence computed; sum reconciles to bill total', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId, bill } = await setUpClaiming(app, creator, [guestA, guestB]);

    // Claim distribution: creator → item[0], guestA → item[1], guestB → item[2]
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestA) },
      body: JSON.stringify({ claimedItemIds: [bill.items[1]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestB) },
      body: JSON.stringify({ claimedItemIds: [bill.items[2]?.itemId] }),
    });

    const lock = await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(lock.status).toBe(200);
    const session = (await lock.json()) as {
      status: string;
      participants: { userId: string; owedPence: number; payment: { status: string } }[];
    };
    expect(session.status).toBe('paying');

    const sumOwed = session.participants.reduce((s, p) => s + p.owedPence, 0);
    expect(sumOwed).toBe(bill.totalPence);

    // creator's payment is self_paid; everyone else is unpaid
    const c = session.participants.find((p) => p.userId === creator);
    const a = session.participants.find((p) => p.userId === guestA);
    expect(c?.payment.status).toBe('self_paid');
    expect(a?.payment.status).toBe('unpaid');
  });

  it('cannot lock twice (state must be claiming)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId, bill } = await setUpClaiming(app, creator, [guestA, guestB]);

    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestA) },
      body: JSON.stringify({ claimedItemIds: [bill.items[1]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestB) },
      body: JSON.stringify({ claimedItemIds: [bill.items[2]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    const second = await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(second.status).toBe(409);
  });

  it('amending the bill is rejected once claims are locked (paying)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId, bill } = await setUpClaiming(app, creator, [guestA, guestB]);

    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestA) },
      body: JSON.stringify({ claimedItemIds: [bill.items[1]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestB) },
      body: JSON.stringify({ claimedItemIds: [bill.items[2]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

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
});

describe('POST /v1/sessions/:id/abandon', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('creator can abandon a setup session', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    const res = await app.request(`/v1/sessions/${sessionId}/abandon`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as { status: string };
    expect(session.status).toBe('abandoned');
  });

  it('non-creator cannot abandon', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    const res = await app.request(`/v1/sessions/${sessionId}/abandon`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(404);
  });

  it('abandoning a paying session unlocks the bill so it can be amended again', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId, bill } = await setUpClaiming(app, creator, [guestA, guestB]);

    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestA) },
      body: JSON.stringify({ claimedItemIds: [bill.items[1]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guestB) },
      body: JSON.stringify({ claimedItemIds: [bill.items[2]?.itemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

    await app.request(`/v1/sessions/${sessionId}/abandon`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

    const amend = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: [{ name: 'restored', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amend.status).toBe(200);
  });
});
