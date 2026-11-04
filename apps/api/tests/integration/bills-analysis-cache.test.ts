import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import { AppError } from '../../src/errors/AppError.js';
import { FixtureBillParser, ThrowingBillParser } from '../../src/services/bills/fixtureParser.js';
import type { BillParser } from '../../src/services/bills/parser.js';
import { ddb, TABLE_NAME } from '../../src/storage/ddb.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import type { Bill } from '../../src/types/bills.js';
import {
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  uniqueImageBytes,
} from './helpers.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const newUser = () => `u-${uuidv7()}`;

const appWith = (parser: BillParser, extra: { allowSkipCache?: boolean } = {}) =>
  createApp({ idTokenVerifier: fakeVerifier, billParser: parser, ...extra });

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

async function parse(
  app: Hono,
  userId: string,
  bytes: Uint8Array,
  extra: { skipCache?: boolean } = {},
): Promise<Response> {
  return app.request('/v1/bills/parse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      ...makeAuth(userId),
    },
    body: JSON.stringify({ uploadId: await upload(userId, bytes), ...extra }),
  });
}

async function parsed(
  app: Hono,
  userId: string,
  bytes: Uint8Array,
  extra: { skipCache?: boolean } = {},
): Promise<Bill> {
  const res = await parse(app, userId, bytes, extra);
  expect(res.status).toBe(200);
  return (await res.json()) as Bill;
}

/** Every ANALYSIS row for these bytes, one per parser fingerprint. */
async function analysisRows(bytes: Uint8Array) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `ANALYSIS#${sha(bytes)}` },
    }),
  );
  return Items ?? [];
}

const lines = (bill: Bill) => bill.items.map(({ itemId: _id, ...rest }) => rest);

describe('bill analysis cache', () => {
  beforeAll(ensureBillsBucket);

  it('caches the read with a TTL, and the same user gets their own bill back', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const app = appWith(parser);
    const userId = newUser();
    const bytes = uniqueImageBytes();

    const first = await parsed(app, userId, bytes);
    expect(first.parsedFrom.source).toBe('parser');
    expect(first.parsedFrom.analysedAt).toBeDefined();
    const again = await parsed(app, userId, bytes);
    expect(again.billId).toBe(first.billId);
    expect(parser.calls).toBe(1);

    const rows = await analysisRows(bytes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sk: `P#${parser.fingerprint}`,
      parser: 'fixture',
      parserVersion: 'v1',
      analysedAt: first.parsedFrom.analysedAt,
    });
    expect(rows[0]?.userId).toBeUndefined();
    const ttl = rows[0]?.ttlAt as number;
    const days = (ttl - Date.parse(first.parsedFrom.analysedAt!) / 1000) / 86_400;
    expect(Math.round(days)).toBe(30);
  });

  it("gives another user with the same bytes a fresh bill from the analysis, not the first user's edits", async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const app = appWith(parser);
    const [alice, bob] = [newUser(), newUser()];
    const bytes = uniqueImageBytes();

    const original = await parsed(app, alice, bytes);
    const amended = await app.request(`/v1/bills/${original.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(alice) },
      body: JSON.stringify({
        items: [{ name: 'Something else', unitPricePence: 999, quantity: 3, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amended.status).toBe(200);

    const bobs = await parsed(app, bob, bytes);
    expect(parser.calls).toBe(1);
    expect(bobs.billId).not.toBe(original.billId);
    expect(bobs.creatorUserId).toBe(bob);
    expect(lines(bobs)).toEqual(lines(original));
    expect(bobs.venue).toEqual(original.venue);
    expect(bobs.totalPence).toBe(original.totalPence);
    const aliceIds = new Set(original.items.map((i) => i.itemId));
    expect(bobs.items.every((i) => !aliceIds.has(i.itemId))).toBe(true);
    expect(bobs.parsedFrom).toMatchObject({
      source: 'cache',
      analysedAt: original.parsedFrom.analysedAt,
      parser: 'fixture',
      parserVersion: 'v1',
      imageHash: sha(bytes),
    });
    expect(bobs.parsedFrom.uploadId).not.toBe(original.parsedFrom.uploadId);
  });

  it('serves background reads from the same cache', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const app = appWith(parser);
    const bytes = uniqueImageBytes();
    await parsed(app, newUser(), bytes);

    const userId = newUser();
    const res = await app.request('/v1/bills/reads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId: await upload(userId, bytes) }),
    });
    expect(res.status).toBe(202);
    const { readId } = (await res.json()) as { readId: string };
    let read: { status: string; billId?: string } = { status: 'reading' };
    for (let i = 0; i < 100 && read.status === 'reading'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const poll = await app.request(`/v1/bills/reads/${readId}`, { headers: makeAuth(userId) });
      read = (await poll.json()) as typeof read;
    }
    expect(read.status).toBe('done');
    const bill = await app.request(`/v1/bills/${read.billId}`, { headers: makeAuth(userId) });
    expect(((await bill.json()) as Bill).parsedFrom.source).toBe('cache');
    expect(parser.calls).toBe(1);
  });

  it('reads again when the parser fingerprint changes, keeping both rows', async () => {
    const bytes = uniqueImageBytes();
    const v1 = new FixtureBillParser(sampleParsedBill, { fingerprint: `fixture:v1:${uuidv7()}` });
    const v2 = new FixtureBillParser(sampleParsedBill, { fingerprint: `fixture:v2:${uuidv7()}` });
    await parsed(appWith(v1), newUser(), bytes);
    const bill = await parsed(appWith(v2), newUser(), bytes);
    expect(v2.calls).toBe(1);
    expect(bill.parsedFrom.source).toBe('parser');
    expect((await analysisRows(bytes)).map((r) => r.sk as string).sort()).toEqual(
      [`P#${v1.fingerprint}`, `P#${v2.fingerprint}`].sort(),
    );
  });

  it('writes nothing when the parser fails', async () => {
    const bytes = uniqueImageBytes();
    const app = appWith(new ThrowingBillParser(new AppError('PARSE_FAILED', 'unreadable')));
    const res = await parse(app, newUser(), bytes);
    expect(res.status).toBe(422);
    expect(await analysisRows(bytes)).toHaveLength(0);
  });

  it('keeps one row when two users read the same new photo at once', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const app = appWith(parser);
    const bytes = uniqueImageBytes();
    const [a, b] = await Promise.all([
      parsed(app, newUser(), bytes),
      parsed(app, newUser(), bytes),
    ]);
    expect(a.billId).not.toBe(b.billId);
    expect(lines(a)).toEqual(lines(b));
    expect(await analysisRows(bytes)).toHaveLength(1);
  });

  it('skipCache reads the photo again', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const app = appWith(parser, { allowSkipCache: true });
    const bytes = uniqueImageBytes();
    await parsed(app, newUser(), bytes);
    const bill = await parsed(app, newUser(), bytes, { skipCache: true });
    expect(parser.calls).toBe(2);
    expect(bill.parsedFrom.source).toBe('parser');
    expect(await analysisRows(bytes)).toHaveLength(1);
  });

  it('reads again past an expired row, and replaces it', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const bytes = uniqueImageBytes();
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `ANALYSIS#${sha(bytes)}`,
          sk: `P#${parser.fingerprint}`,
          parsed: { ...sampleParsedBill, items: [{ ...sampleParsedBill.items[0], name: 'Old' }] },
          parser: 'fixture',
          parserVersion: 'v1',
          analysedAt: '2026-01-01T00:00:00.000Z',
          ttlAt: Math.floor(Date.now() / 1000) - 60,
        },
      }),
    );
    const bill = await parsed(appWith(parser), newUser(), bytes);
    expect(parser.calls).toBe(1);
    expect(bill.items).toHaveLength(3);
    const [row] = await analysisRows(bytes);
    expect(row?.analysedAt).toBe(bill.parsedFrom.analysedAt);
  });

  it('reads again past a row that no longer fits the schema', async () => {
    const parser = new FixtureBillParser(sampleParsedBill);
    const bytes = uniqueImageBytes();
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `ANALYSIS#${sha(bytes)}`,
          sk: `P#${parser.fingerprint}`,
          parsed: { items: [] },
          parser: 'fixture',
          parserVersion: 'v1',
          analysedAt: new Date().toISOString(),
          ttlAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );
    const bill = await parsed(appWith(parser), newUser(), bytes);
    expect(parser.calls).toBe(1);
    expect(bill.parsedFrom.source).toBe('parser');
  });
});
