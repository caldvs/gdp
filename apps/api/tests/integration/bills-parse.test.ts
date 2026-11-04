import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import { readQuotaStore } from '../../src/storage/readQuotaStore.js';
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
    await putObject(userId, uploadId, uniqueImageBytes());

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
    // sum(items) = 1450 + 650 + 750 = 2850 (all qty=1 in the simplified fixture)
    expect(bill.subtotalPence).toBe(2850);
    expect(bill.serviceChargePence).toBe(356);
    expect(bill.totalPence).toBe(2850 + 0 + 356);
    expect(bill.items).toHaveLength(3);
    expect(bill.items[0]?.itemId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bill.parsedFrom.parser).toBe('fixture');
  });

  it('credits the bill to the model a result says read it', async () => {
    const parser = {
      model: 'eu.anthropic.claude-haiku',
      version: 'v3',
      fingerprint: `eu.anthropic.claude-haiku:v3:${uuidv7()}`,
      parse: () =>
        Promise.resolve({ ...sampleParsedBill, readBy: { model: 'other-model', version: 'v9' } }),
    };
    const app = createApp({ idTokenVerifier: fakeVerifier, billParser: parser });
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await putObject(userId, uploadId, uniqueImageBytes());
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
    const bill = (await res.json()) as { parsedFrom: { parser: string; parserVersion: string } };
    expect(bill.parsedFrom).toMatchObject({ parser: 'other-model', parserVersion: 'v9' });
  });

  it('returns a cached response on idempotency replay', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    const idempotencyKey = newIdempotencyKey();
    await putObject(userId, uploadId, uniqueImageBytes());

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
    await putObject(userId, uploadId1, uniqueImageBytes());
    await putObject(userId, uploadId2, uniqueImageBytes());

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
    await putObject(userA, uploadId, uniqueImageBytes());

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
    const bytes = uniqueImageBytes();
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

  it('persists parsedTotalPence when the parser provided a printed total', async () => {
    // sampleParsedBill has totalPence: 3206 and the computed total
    // (subtotal 2850 + service 356 + tax 0) also lands at 3206, so no
    // mismatch — we just verify the field surfaces.
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await putObject(userId, uploadId, uniqueImageBytes());
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
    const bill = (await res.json()) as { totalPence: number; parsedTotalPence?: number };
    expect(bill.parsedTotalPence).toBe(sampleParsedBill.totalPence);
    expect(bill.totalPence).toBe(sampleParsedBill.totalPence);
  });

  it('surfaces parsedTotalPence diverging from the computed totalPence', async () => {
    // Pretend the reader misread the receipt: the printed total it returned
    // is £35.00 (3500) but the items + service + tax compute to £32.06
    // (3206). The bill's totalPence is the computed value; the printed
    // value lives alongside it so the client can flag the discrepancy.
    const divergent = { ...sampleParsedBill, totalPence: 3500 };
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(divergent),
    });
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await putObject(userId, uploadId, uniqueImageBytes());
    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    const bill = (await res.json()) as {
      billId: string;
      totalPence: number;
      parsedTotalPence?: number;
    };
    expect(bill.parsedTotalPence).toBe(3500);
    expect(bill.totalPence).toBe(3206);
    // GET surfaces both as well.
    const got = await app.request(`/v1/bills/${bill.billId}`, {
      headers: makeAuth(userId),
    });
    const fetched = (await got.json()) as { totalPence: number; parsedTotalPence?: number };
    expect(fetched.parsedTotalPence).toBe(3500);
  });
  it('refuses a new read once the daily quota is used, but serves cached photos (#145)', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const parse = async (uploadId: string) =>
      app.request('/v1/bills/parse', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': newIdempotencyKey(),
          ...makeAuth(userId),
        },
        body: JSON.stringify({ uploadId }),
      });

    const cachedBytes = uniqueImageBytes();
    const first = uuidv7();
    await putObject(userId, first, cachedBytes);
    expect((await parse(first)).status).toBe(200);
    for (let i = 1; i < readQuotaStore.READS_PER_DAY; i++) await readQuotaStore.reserve(userId);

    const fresh = uuidv7();
    await putObject(userId, fresh, uniqueImageBytes());
    const refused = await parse(fresh);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as {
      error: { code: string; details?: { retryAfterSeconds?: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);

    // The same photo again comes from the cache and isn't refused.
    const again = uuidv7();
    await putObject(userId, again, cachedBytes);
    expect((await parse(again)).status).toBe(200);
  });
});

describe('lines the reader is unsure of', () => {
  it('keeps the note on the bill, and an amend clears it', async () => {
    const unsure = {
      ...sampleParsedBill,
      items: sampleParsedBill.items.map((it, i) =>
        i === 0 ? { ...it, unsure: 'price faded' } : it,
      ),
    };
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(unsure),
    });
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await putObject(userId, uploadId, uniqueImageBytes());
    const res = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    const bill = (await res.json()) as {
      billId: string;
      items: {
        itemId: string;
        name: string;
        unitPricePence: number;
        quantity: number;
        category: string;
        unsure?: string;
      }[];
      taxPence: number;
      serviceChargePence: number;
    };
    expect(bill.items.map((i) => i.unsure)).toEqual([
      'price faded',
      ...bill.items.slice(1).map(() => undefined),
    ]);

    const amended = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: bill.items.map(({ itemId, name, unitPricePence, quantity, category }) => ({
          itemId,
          name,
          unitPricePence,
          quantity,
          category,
        })),
        taxPence: bill.taxPence,
        serviceChargePence: bill.serviceChargePence,
      }),
    });
    expect(amended.status).toBe(200);
    const after = (await amended.json()) as { items: { unsure?: string }[] };
    expect(after.items.every((i) => i.unsure === undefined)).toBe(true);
  });
});
