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

async function createBill(app: ReturnType<typeof buildApp>, userId: string) {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: new Uint8Array([1, 2, 3, Math.floor(Math.random() * 255)]),
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
    versionNumber: number;
    items: Array<{
      itemId: string;
      name: string;
      unitPricePence: number;
      quantity: number;
      category: string;
    }>;
  };
}

describe('GET /v1/bills/:billId', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('returns 404 BILL_NOT_FOUND for an unknown id', async () => {
    const app = buildApp();
    const res = await app.request(`/v1/bills/${uuidv7()}`, {
      headers: makeAuth(`u-${uuidv7()}`),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BILL_NOT_FOUND');
  });

  it('returns the latest version by default', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const res = await app.request(`/v1/bills/${created.billId}`, {
      headers: makeAuth(userId),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as { billId: string; versionNumber: number };
    expect(bill.billId).toBe(created.billId);
    expect(bill.versionNumber).toBe(1);
  });

  it('returns a specific version when ?version is supplied', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const res = await app.request(`/v1/bills/${created.billId}?version=1`, {
      headers: makeAuth(userId),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as { versionNumber: number };
    expect(bill.versionNumber).toBe(1);
  });
});

describe('POST /v1/bills/:billId/amend', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('creates a new version with reconciled totals', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const amendment = {
      items: [
        // preserve existing item id, change price
        {
          itemId: created.items[0]?.itemId,
          name: 'Margherita Pizza (corrected)',
          unitPricePence: 1500,
          quantity: 2,
          category: 'food' as const,
        },
        // new item without itemId
        { name: 'Espresso', unitPricePence: 250, quantity: 4, category: 'drink' as const },
      ],
      taxPence: 0,
      serviceChargePence: 400,
    };

    const res = await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify(amendment),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as {
      versionNumber: number;
      subtotalPence: number;
      totalPence: number;
      items: Array<{ itemId: string; name: string }>;
    };
    expect(bill.versionNumber).toBe(2);
    // 2*1500 + 4*250 = 3000 + 1000 = 4000
    expect(bill.subtotalPence).toBe(4000);
    expect(bill.totalPence).toBe(4400);
    expect(bill.items).toHaveLength(2);
    // preserved itemId
    expect(bill.items[0]?.itemId).toBe(created.items[0]?.itemId);
    // new itemId minted
    expect(bill.items[1]?.itemId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bill.items[1]?.itemId).not.toBe(created.items[0]?.itemId);
  });

  it('returns 404 BILL_NOT_FOUND when caller is not the creator', async () => {
    const app = buildApp();
    const creator = `creator-${uuidv7()}`;
    const interloper = `bad-${uuidv7()}`;
    const created = await createBill(app, creator);

    const res = await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(interloper) },
      body: JSON.stringify({
        items: [{ name: 'x', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BILL_NOT_FOUND');
  });

  it('preserves history: GET ?version=1 still returns the original after an amendment', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: [{ name: 'changed', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });

    const v1 = await app.request(`/v1/bills/${created.billId}?version=1`, {
      headers: makeAuth(userId),
    });
    const v1Body = (await v1.json()) as { items: Array<{ name: string }>; versionNumber: number };
    expect(v1Body.versionNumber).toBe(1);
    expect(v1Body.items[0]?.name).toBe('Margherita Pizza');

    const latest = await app.request(`/v1/bills/${created.billId}`, {
      headers: makeAuth(userId),
    });
    const latestBody = (await latest.json()) as {
      items: Array<{ name: string }>;
      versionNumber: number;
    };
    expect(latestBody.versionNumber).toBe(2);
    expect(latestBody.items[0]?.name).toBe('changed');
  });
});
