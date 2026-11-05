/**
 * Start again (docs/design/analysis-cache.md, step 3): POST
 * /v1/bills/{billId}/fork makes a new bill for the same photo, from the
 * latest version or from today's read, and the photo then opens it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { readQuotaStore } from '../../src/storage/readQuotaStore.js';
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

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const lines = (bill: Bill) => bill.items.map(({ itemId: _id, ...rest }) => rest);

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

async function parse(app: App, userId: string, bytes: Uint8Array): Promise<Bill> {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: bytes,
      ContentType: 'image/jpeg',
    }),
  );
  const res = await post(app, '/v1/bills/parse', userId, { uploadId });
  expect(res.status).toBe(200);
  return (await res.json()) as Bill;
}

async function fork(app: App, userId: string, billId: string, from?: 'latest' | 'analysis') {
  return post(app, `/v1/bills/${billId}/fork`, userId, from ? { from } : {});
}

async function forked(app: App, userId: string, billId: string, from?: 'latest' | 'analysis') {
  const res = await fork(app, userId, billId, from);
  expect(res.status).toBe(201);
  return (await res.json()) as Bill;
}

/** Changes every price to £1, so the amended bill differs from the read. */
async function amend(app: App, lead: string, bill: Bill): Promise<Bill> {
  const res = await post(app, `/v1/bills/${bill.billId}/amend`, lead, {
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
  expect(res.status).toBe(200);
  return (await res.json()) as Bill;
}

async function uploadSlot(app: App, userId: string, bytes: Uint8Array) {
  const res = await post(app, '/v1/bills/uploads', userId, {
    sha256: sha(bytes),
    sizeBytes: bytes.byteLength,
    mimeType: 'image/jpeg',
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const appWith = (parser: FixtureBillParser) =>
  createApp({ idTokenVerifier: fakeVerifier, billParser: parser });

function setup() {
  const parser = new FixtureBillParser(sampleParsedBill);
  return { app: appWith(parser), parser, lead: `lead-${uuidv7()}`, bytes: uniqueImageBytes() };
}

beforeAll(ensureBillsBucket);

describe('POST /v1/bills/{billId}/fork', () => {
  it('latest: a new bill copying the amended version, with new item ids', async () => {
    const { app, parser, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    const amended = await amend(app, lead, first);

    const bill = await forked(app, lead, first.billId);
    expect(bill.billId).not.toBe(first.billId);
    expect(bill.versionNumber).toBe(1);
    expect(bill.previousVersionId).toBeUndefined();
    expect(lines(bill)).toEqual(lines(amended));
    expect(bill.totalPence).toBe(amended.totalPence);
    expect(bill.venue).toEqual(amended.venue);
    const ids = bill.items.map((i) => i.itemId);
    expect(ids.some((id) => amended.items.some((i) => i.itemId === id))).toBe(false);
    expect(bill.parsedFrom).toMatchObject({
      imageHash: sha(bytes),
      uploadId: first.parsedFrom.uploadId,
      forkedFrom: { billId: first.billId, versionNumber: 2 },
    });
    expect(parser.calls).toBe(1);

    // Stored, and readable by its owner.
    const got = await app.request(`/v1/bills/${bill.billId}`, { headers: makeAuth(lead) });
    expect(((await got.json()) as Bill).items.map((i) => i.itemId)).toEqual(ids);
  });

  it('analysis: a new bill from the read, not the corrections, without reading again', async () => {
    const { app, parser, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    await amend(app, lead, first);

    const bill = await forked(app, lead, first.billId, 'analysis');
    expect(lines(bill)).toEqual(lines(first));
    expect(bill.totalPence).toBe(first.totalPence);
    expect(bill.parsedFrom).toMatchObject({
      source: 'cache',
      analysedAt: first.parsedFrom.analysedAt,
      uploadId: first.parsedFrom.uploadId,
      forkedFrom: { billId: first.billId, versionNumber: 2 },
    });
    expect(parser.calls).toBe(1);
  });

  it("analysis with a newer parser: reads again, and that counts against the day's reads", async () => {
    const { app, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    // One read used by the parse; leave one.
    for (let i = 2; i < readQuotaStore.READS_PER_DAY; i++) await readQuotaStore.reserve(lead);

    const newer = new FixtureBillParser(
      {
        ...sampleParsedBill,
        items: [{ name: 'Pizza', unitPricePence: 1200, quantity: 1, category: 'food' }],
      },
      { fingerprint: `fixture:v2:${uuidv7()}` },
    );
    const bill = await forked(appWith(newer), lead, first.billId, 'analysis');
    expect(newer.calls).toBe(1);
    expect(bill.parsedFrom.source).toBe('parser');
    expect(bill.items.map((i) => i.name)).toEqual(['Pizza']);

    // The cap is reached: another new parser can't read it today.
    const newest = new FixtureBillParser(sampleParsedBill, {
      fingerprint: `fixture:v3:${uuidv7()}`,
    });
    const refused = await fork(appWith(newest), lead, bill.billId, 'analysis');
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(newest.calls).toBe(0);
    // A read already cached for this parser doesn't count.
    expect((await fork(appWith(newer), lead, bill.billId, 'analysis')).status).toBe(201);
    expect(newer.calls).toBe(1);
  });

  it('repoints the photo: sending it again opens the new bill', async () => {
    const { app, parser, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    const bill = await forked(app, lead, first.billId);

    expect(await uploadSlot(app, lead, bytes)).toEqual({
      status: 'duplicate',
      billId: bill.billId,
      versionNumber: 1,
      amended: false,
    });
    expect((await parse(app, lead, bytes)).billId).toBe(bill.billId);
    expect(parser.calls).toBe(1);
  });

  it('owner only: anyone else, a guest at the table included, gets 404', async () => {
    const { app, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    const created = await post(app, '/v1/sessions', lead, { billId: first.billId });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await setPayoutFor(app, lead);
    expect((await post(app, `/v1/sessions/${sessionId}/share`, lead)).status).toBe(200);
    const guest = `g-${uuidv7()}`;
    expect((await post(app, `/v1/sessions/${sessionId}/join`, guest)).status).toBe(200);

    for (const user of [guest, `x-${uuidv7()}`]) {
      const res = await fork(app, user, first.billId);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BILL_NOT_FOUND');
    }
    expect((await fork(app, lead, uuidv7())).status).toBe(404);
    expect((await uploadSlot(app, lead, bytes)).billId).toBe(first.billId);
  });

  it('rejects an unknown source', async () => {
    const { app, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    expect(
      (await post(app, `/v1/bills/${first.billId}/fork`, lead, { from: 'photo' })).status,
    ).toBe(400);
  });

  it('leaves the settled session and its bill as they were', async () => {
    const { app, lead, bytes } = setup();
    const first = await parse(app, lead, bytes);
    const created = await post(app, '/v1/sessions', lead, { billId: first.billId });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await setPayoutFor(app, lead);
    expect((await post(app, `/v1/sessions/${sessionId}/share`, lead)).status).toBe(200);
    expect((await post(app, `/v1/sessions/${sessionId}/close`, lead)).status).toBe(200);
    const before = await (
      await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(lead) })
    ).json();

    const bill = await forked(app, lead, first.billId);

    const after = await (
      await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(lead) })
    ).json();
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: 'settled', billId: first.billId });
    const old = await app.request(`/v1/bills/${first.billId}`, { headers: makeAuth(lead) });
    expect(((await old.json()) as Bill).items).toEqual(first.items);
    // The photo now opens the new bill, which isn't in any session.
    expect(await uploadSlot(app, lead, bytes)).toEqual({
      status: 'duplicate',
      billId: bill.billId,
      versionNumber: 1,
      amended: false,
    });
    // The new bill can go to a table of its own.
    expect((await post(app, '/v1/sessions', lead, { billId: bill.billId })).status).toBe(201);
  });
});
