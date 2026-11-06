import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import {
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  setPayoutFor,
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

  it('returns 404 BILL_NOT_FOUND when the caller is not the creator and not a session participant', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const created = await createBill(app, creator);

    const res = await app.request(`/v1/bills/${created.billId}`, {
      headers: makeAuth(stranger),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BILL_NOT_FOUND');
  });

  it('lets a session participant read the pinned bill', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const created = await createBill(app, creator);

    // Lead creates session, shares (transitions to claiming), guest joins.
    const sessionRes = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: created.billId }),
    });
    const session = (await sessionRes.json()) as { sessionId: string };
    await setPayoutFor(app, creator);
    await app.request(`/v1/sessions/${session.sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    await app.request(`/v1/sessions/${session.sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    // Guest can now read the bill (they need the items to claim against)
    const res = await app.request(`/v1/bills/${created.billId}`, {
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { billId: string; items: unknown[] };
    expect(body.billId).toBe(created.billId);
    expect(Array.isArray(body.items)).toBe(true);
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

  it('a venue the lead sets replaces the parsed one', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const res = await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: [{ name: 'x', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
        venue: { name: 'The Chosen Place' },
      }),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as { venue?: { name: string } };
    expect(bill.venue?.name).toBe('The Chosen Place');
  });

  it('keeps the parsed venue when the lead sends none', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const res = await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: [{ name: 'x', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(res.status).toBe(200);
    const bill = (await res.json()) as { venue?: { name: string } };
    expect(bill.venue?.name).toBe('Pizzeria Test');
  });

  it('a venue name too long is rejected', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const created = await createBill(app, userId);

    const res = await app.request(`/v1/bills/${created.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: [{ name: 'x', unitPricePence: 100, quantity: 1, category: 'food' }],
        taxPence: 0,
        serviceChargePence: 0,
        venue: { name: 'x'.repeat(81) },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('a discount that is not one item’s (8 Nov 2026)', () => {
  // The Holland, 6 Jul 2025: £61.25 of items, a £50 loyalty discount, 12.5%
  // service on the items, VAT printed inside the total. TOTAL £19.91.
  const holland = new FixtureBillParser({
    items: [
      { name: 'Roast Beef', unitPricePence: 2600, quantity: 2, category: 'food' },
      { name: 'Small Gravy', unitPricePence: 150, quantity: 1, category: 'food' },
      { name: 'Diet Coke', unitPricePence: 375, quantity: 1, category: 'drink' },
      { name: 'Flat White', unitPricePence: 400, quantity: 1, category: 'drink' },
      { name: '>£1 SHIFT Charity Donation', unitPricePence: 100, quantity: 1, category: 'other' },
    ],
    discounts: [{ name: 'Fork Loyalty Discount £50', amountPence: 5000 }],
    taxPence: 201,
    serviceChargePence: 766,
    totalPence: 1991,
    currency: 'GBP',
  });
  const app = () => createApp({ idTokenVerifier: fakeVerifier, billParser: holland });
  type Out = {
    billId: string;
    subtotalPence: number;
    taxPence: number;
    totalPence: number;
    discounts: { name: string; amountPence: number }[];
    items: {
      itemId: string;
      name: string;
      unitPricePence: number;
      quantity: number;
      category: string;
    }[];
  };
  const amend = (a: ReturnType<typeof app>, userId: string, b: Out, extra: object) =>
    a.request(`/v1/bills/${b.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        items: b.items.map(({ itemId, name, unitPricePence, quantity, category }) => ({
          itemId,
          name,
          unitPricePence,
          quantity,
          category,
        })),
        taxPence: 0,
        serviceChargePence: 766,
        ...extra,
      }),
    });

  it('reads it as its own line, items at their printed prices, the VAT left inside', async () => {
    const a = app();
    const userId = `u-${uuidv7()}`;
    const bill = (await createBill(a, userId)) as unknown as Out;
    expect(bill.subtotalPence).toBe(6225);
    expect(bill.taxPence).toBe(0);
    expect(bill.discounts).toEqual([{ name: 'Fork Loyalty Discount £50', amountPence: 5000 }]);
    expect(bill.totalPence).toBe(1991);
  });

  it('an amend keeps it unless changed, can remove it, and can’t take off more than the items', async () => {
    const a = app();
    const userId = `u-${uuidv7()}`;
    const bill = (await createBill(a, userId)) as unknown as Out;

    const kept = (await (await amend(a, userId, bill, {})).json()) as Out;
    expect(kept.discounts).toEqual(bill.discounts);
    expect(kept.totalPence).toBe(1991);

    const changed = (await (
      await amend(a, userId, kept, { discounts: [{ name: 'Loyalty', amountPence: 4000 }] })
    ).json()) as Out;
    expect(changed.totalPence).toBe(2991);

    const removed = (await (await amend(a, userId, changed, { discounts: [] })).json()) as Out;
    expect(removed.discounts).toEqual([]);
    expect(removed.totalPence).toBe(6991);

    const tooMuch = await amend(a, userId, removed, {
      discounts: [{ name: 'Loyalty', amountPence: 6226 }],
    });
    expect(tooMuch.status).toBe(400);
    expect(((await tooMuch.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT',
    );
  });
});
