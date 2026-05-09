import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import { sessionStore } from '../../src/storage/sessionStore.js';
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

async function buildSharedSession(app: ReturnType<typeof buildApp>, creator: string) {
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
  // Share returns the activated joinCode.
  const shareRes = await app.request(`/v1/sessions/${initial.sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  const shared = (await shareRes.json()) as { joinCode: string };
  return { sessionId: initial.sessionId, joinCode: shared.joinCode, bill };
}

describe('Join code resolution and joining', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('resolves a valid join code from a claiming session to its sessionId', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, joinCode } = await buildSharedSession(app, creator);

    const res = await app.request('/v1/sessions/by-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(`o-${uuidv7()}`) },
      body: JSON.stringify({ code: joinCode }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(sessionId);
  });

  it('returns 404 when resolving an unknown code', async () => {
    const app = buildApp();
    const res = await app.request('/v1/sessions/by-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(`o-${uuidv7()}`) },
      body: JSON.stringify({ code: 'ZZZZZZ' }),
    });
    expect(res.status).toBe(404);
  });

  it('does not resolve the code while the session is still in setup', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBill(app, creator);
    const create = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const sessionId = ((await create.json()) as { sessionId: string }).sessionId;

    // The code is hidden from the API in setup; peek at the underlying row
    // to confirm /by-code rejects even when the caller knows the code.
    const internal = await sessionStore.get(sessionId);
    const code = internal?.joinCode;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const res = await app.request('/v1/sessions/by-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(`o-${uuidv7()}`) },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(404);
  });

  it('joining a claiming session adds the caller as a participant', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildSharedSession(app, creator);

    const res = await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as { participants: { userId: string }[] };
    expect(session.participants.map((p) => p.userId).sort()).toEqual([creator, guest].sort());
  });

  it('joining the same session twice is idempotent', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildSharedSession(app, creator);

    await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    const second = await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { participants: { userId: string }[] };
    expect(body.participants.filter((p) => p.userId === guest)).toHaveLength(1);
  });

  it('rejects joining a session that is still in setup', async () => {
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

    const res = await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /v1/sessions/:id/claims', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it("replaces the caller's claim list (full replacement, not delta)", async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId, bill } = await buildSharedSession(app, creator);

    await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    // first claim: items 1 & 2
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({
        claimedItemIds: [bill.items[1]?.itemId, bill.items[2]?.itemId],
      }),
    });
    // second claim: just item 1 (replace)
    const res = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [bill.items[1]?.itemId] }),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as {
      participants: { userId: string; claimedItemIds: string[] }[];
    };
    const guestPart = session.participants.find((p) => p.userId === guest);
    expect(guestPart?.claimedItemIds).toEqual([bill.items[1]?.itemId]);
  });

  it('rejects claims for itemIds not on the bill', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildSharedSession(app, creator);
    await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    const res = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [uuidv7()] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it("creator's claims are frozen once share has been called", async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, bill } = await buildSharedSession(app, creator);

    // Session is now in claiming. Creator tries to update claims.
    const res = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        claimedItemIds: [bill.items[1]?.itemId, bill.items[2]?.itemId],
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('rejects claims from non-participants', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const { sessionId, bill } = await buildSharedSession(app, creator);

    const res = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(stranger) },
      body: JSON.stringify({ claimedItemIds: [bill.items[0]?.itemId] }),
    });
    expect(res.status).toBe(404);
  });
});
