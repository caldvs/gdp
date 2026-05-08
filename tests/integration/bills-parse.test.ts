import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import { fakeVerifier, makeAuth, newIdempotencyKey, sampleParsedBill } from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

async function putObject(userId: string, uploadId: string, bytes: Uint8Array) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: bytes,
      ContentType: 'image/jpeg',
    }),
  );
}

describe('POST /v1/bills/parse', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('rejects requests missing the Idempotency-Key header', async () => {
    const app = buildApp();
    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth('u1') },
      body: JSON.stringify({ uploadId: uuidv7() }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('returns NOT_FOUND when the upload does not exist in S3', async () => {
    const app = buildApp();
    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth('u1'),
      },
      body: JSON.stringify({ uploadId: uuidv7() }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('parses an uploaded image into a Bill v1 with reconciled totals', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await putObject(userId, uploadId, new Uint8Array([1, 2, 3, 4, 5]));

    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as {
      billId: string;
      versionNumber: number;
      creatorUserId: string;
      currency: string;
      subtotalPence: number;
      taxPence: number;
      serviceChargePence: number;
      totalPence: number;
      items: Array<{ itemId: string; name: string }>;
      parsedFrom: { imageHash: string; parser: string };
    };
    expect(bill.versionNumber).toBe(1);
    expect(bill.creatorUserId).toBe(userId);
    expect(bill.currency).toBe('GBP');
    // sum(items) = 2*1450 + 3*650 + 1*750 = 2900 + 1950 + 750 = 5600
    expect(bill.subtotalPence).toBe(5600);
    expect(bill.serviceChargePence).toBe(575);
    expect(bill.totalPence).toBe(5600 + 0 + 575);
    expect(bill.items).toHaveLength(3);
    expect(bill.items[0]?.itemId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bill.parsedFrom.parser).toBe('fixture');
  });

  it('returns a cached response on idempotency replay', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    const idempotencyKey = newIdempotencyKey();
    await putObject(userId, uploadId, new Uint8Array([10, 11, 12]));

    const first = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { billId: string };

    const second = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    const secondBody = (await second.json()) as { billId: string };
    expect(secondBody.billId).toBe(firstBody.billId);
  });

  it('returns IDEMPOTENCY_CONFLICT when the same key is reused with a different body', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId1 = uuidv7();
    const uploadId2 = uuidv7();
    const idempotencyKey = newIdempotencyKey();
    await putObject(userId, uploadId1, new Uint8Array([1]));
    await putObject(userId, uploadId2, new Uint8Array([2]));

    await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId: uploadId1 }),
    });

    const conflict = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId: uploadId2 }),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it("user A cannot parse user B's upload (different s3 prefix)", async () => {
    const app = buildApp();
    const userA = `a-${uuidv7()}`;
    const userB = `b-${uuidv7()}`;
    const uploadId = uuidv7();
    // upload as A
    await putObject(userA, uploadId, new Uint8Array([1, 2, 3]));

    // B tries to parse same uploadId
    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userB),
      },
      body: JSON.stringify({ uploadId }),
    });
    expect(res.status).toBe(404);
  });

  it('re-parsing the same image bytes returns the existing bill (hash dedupe)', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const bytes = new Uint8Array([42, 43, 44, 45, 46]);
    const uploadId1 = uuidv7();
    const uploadId2 = uuidv7();
    await putObject(userId, uploadId1, bytes);
    await putObject(userId, uploadId2, bytes);

    const first = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId: uploadId1 }),
    });
    const firstBody = (await first.json()) as { billId: string };

    const second = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId: uploadId2 }),
    });
    const secondBody = (await second.json()) as { billId: string };

    expect(secondBody.billId).toBe(firstBody.billId);
  });
});
