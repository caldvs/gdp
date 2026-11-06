/**
 * A photo the lead has sent before (docs/design/analysis-cache.md, step 2):
 * the upload, the synchronous parse and the background read all say where
 * their own bill stands, so the app can take them back to it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../src/lib/uuid.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import type { Bill } from '../../src/types/bills.js';
import {
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  setPayoutFor,
  uniqueImageBytes,
} from './helpers.js';

type App = ReturnType<typeof createApp>;
type Context = {
  versionNumber: number;
  amended: boolean;
  session?: { sessionId: string; status: string };
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function post(app: App, path: string, user: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      ...makeAuth(user),
      'idempotency-key': newIdempotencyKey(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function upload(userId: string, bytes: Uint8Array): Promise<string> {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: bytes,
      ContentType: 'image/jpeg',
    }),
  );
  return uploadId;
}

async function parse(app: App, userId: string, bytes: Uint8Array) {
  const res = await post(app, '/v1/bills/parse', userId, {
    uploadId: await upload(userId, bytes),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Bill & { duplicate?: Context };
}

/** What `POST /v1/bills/uploads` says about these bytes. */
async function uploadSlot(app: App, userId: string, bytes: Uint8Array) {
  const res = await post(app, '/v1/bills/uploads', userId, {
    sha256: sha(bytes),
    sizeBytes: bytes.byteLength,
    mimeType: 'image/jpeg',
  });
  expect(res.status).toBe(200);
  return (await res.json()) as
    { status: 'new' } | ({ status: 'duplicate'; billId: string } & Context);
}

/** A background read of these bytes, polled to the end. */
async function read(app: App, userId: string, bytes: Uint8Array) {
  const started = await post(app, '/v1/bills/reads', userId, {
    uploadId: await upload(userId, bytes),
  });
  expect(started.status).toBe(202);
  const { readId } = (await started.json()) as { readId: string };
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/v1/bills/reads/${readId}`, { headers: makeAuth(userId) });
    const r = (await res.json()) as { status: string; billId?: string; duplicate?: Context };
    if (r.status !== 'reading') return r;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('read never finished');
}

/** A session for the bill, shared so it's `claiming`. */
async function share(app: App, lead: string, billId: string): Promise<string> {
  const created = await post(app, '/v1/sessions', lead, { billId });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  await setPayoutFor(app, lead);
  expect((await post(app, `/v1/sessions/${sessionId}/share`, lead)).status).toBe(200);
  return sessionId;
}

function setup() {
  const parser = new FixtureBillParser(sampleParsedBill);
  const app = createApp({ idTokenVerifier: fakeVerifier, billParser: parser });
  return { app, parser, lead: `lead-${uuidv7()}`, bytes: uniqueImageBytes() };
}

beforeAll(ensureBillsBucket);

describe('a photo the lead has sent before', () => {
  it('untouched: the same bill, read once, not amended, no session', async () => {
    const { app, parser, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    expect(first.duplicate).toBeUndefined();

    const slot = await uploadSlot(app, lead, bytes);
    expect(slot).toEqual({
      status: 'duplicate',
      billId: first.billId,
      versionNumber: 1,
      amended: false,
    });
    const again = await parse(app, lead, bytes);
    expect(again.billId).toBe(first.billId);
    expect(again.duplicate).toEqual({ versionNumber: 1, amended: false });
    const r = await read(app, lead, bytes);
    expect(r).toMatchObject({ status: 'done', billId: first.billId });
    expect(r.duplicate).toEqual({ versionNumber: 1, amended: false });
    expect(parser.calls).toBe(1);
  });

  it('amended: the latest version, marked amended', async () => {
    const { app, lead, bytes } = setup();
    const bill = await parse(app, lead, bytes);
    const amend = await post(app, `/v1/bills/${bill.billId}/amend`, lead, {
      items: bill.items.map(({ itemId, name, quantity, category }) => ({
        itemId,
        name,
        unitPricePence: 100,
        quantity,
        category,
      })),
      taxPence: 0,
      serviceChargePence: 0,
    });
    expect(amend.status).toBe(200);

    const slot = await uploadSlot(app, lead, bytes);
    expect(slot).toMatchObject({ status: 'duplicate', versionNumber: 2, amended: true });
    expect(slot).not.toHaveProperty('session');
    const again = await parse(app, lead, bytes);
    expect(again.versionNumber).toBe(2);
    expect(again.duplicate).toEqual({ versionNumber: 2, amended: true });
  });

  it('in a claiming session: carries the session', async () => {
    const { app, lead, bytes } = setup();
    const bill = await parse(app, lead, bytes);
    const sessionId = await share(app, lead, bill.billId);

    const session = { sessionId, status: 'claiming' };
    expect(await uploadSlot(app, lead, bytes)).toMatchObject({ status: 'duplicate', session });
    expect((await parse(app, lead, bytes)).duplicate?.session).toEqual(session);
    expect((await read(app, lead, bytes)).duplicate?.session).toEqual(session);
  });

  it('abandoned: no session, back to Review bill', async () => {
    const { app, lead, bytes } = setup();
    const bill = await parse(app, lead, bytes);
    const created = await post(app, '/v1/sessions', lead, { billId: bill.billId });
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect((await post(app, `/v1/sessions/${sessionId}/abandon`, lead)).status).toBe(200);

    const slot = await uploadSlot(app, lead, bytes);
    expect(slot).toMatchObject({ status: 'duplicate', billId: bill.billId, amended: false });
    expect(slot).not.toHaveProperty('session');
  });

  it('settled: carries the settled session, though closing released the bill', async () => {
    const { app, lead, bytes } = setup();
    const bill = await parse(app, lead, bytes);
    const sessionId = await share(app, lead, bill.billId);
    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);

    expect(await uploadSlot(app, lead, bytes)).toMatchObject({
      status: 'duplicate',
      session: { sessionId, status: 'settled' },
    });
    // Closed bills are released (the lead can share again): a new session wins.
    const next = await share(app, lead, bill.billId);
    expect(await uploadSlot(app, lead, bytes)).toMatchObject({
      session: { sessionId: next, status: 'claiming' },
    });
  });

  it("a guest at the lead's table who sends the same photo gets their own bill", async () => {
    const { app, lead, bytes } = setup();
    const bill = await parse(app, lead, bytes);
    const sessionId = await share(app, lead, bill.billId);
    const guest = `g-${uuidv7()}`;
    expect((await post(app, `/v1/sessions/${sessionId}/join`, guest)).status).toBe(200);

    expect((await uploadSlot(app, guest, bytes)).status).toBe('new');
    const theirs = await parse(app, guest, bytes);
    expect(theirs.billId).not.toBe(bill.billId);
    expect(theirs.duplicate).toBeUndefined();
  });
});
