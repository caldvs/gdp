import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { NoopVenueResolver, type VenueResolver } from '../../src/services/bills/venueResolver.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import { fakeVerifier, makeAuth, newIdempotencyKey, sampleParsedBill } from './helpers.js';
import type { Bill, Venue } from '../../src/types/bills.js';
import type { Hono } from 'hono';

async function putObject(userId: string, uploadId: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: new Uint8Array([0xff, 0xd8, 0xff, ...new Array<number>(64).fill(0)]),
      ContentType: 'image/jpeg',
    }),
  );
}

async function parseBill(app: Hono, userId: string): Promise<Bill> {
  const uploadId = uuidv7();
  await putObject(userId, uploadId);
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
  return (await res.json()) as Bill;
}

describe('venue resolution in /v1/bills/parse', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('with NoopVenueResolver: passes parsed venue text through unchanged', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
      venueResolver: new NoopVenueResolver(),
    });
    const bill = await parseBill(app, `u-noop-${uuidv7()}`);
    expect(bill.venue).toEqual({
      name: sampleParsedBill.venue!.name,
      address: sampleParsedBill.venue!.address,
    });
    expect(bill.venue?.placeId).toBeUndefined();
    expect(bill.venue?.lat).toBeUndefined();
  });

  it('with a stub resolver: enriches venue with placeId + coordinates', async () => {
    const enriched: Venue = {
      placeId: 'ChIJ-test-123',
      name: 'Pizzeria Test',
      address: '1 Test Street, London W1F 0EF, UK',
      lat: 51.5135,
      lng: -0.1336,
    };
    const stub: VenueResolver = { resolve: () => Promise.resolve(enriched) };
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
      venueResolver: stub,
    });
    const bill = await parseBill(app, `u-stub-${uuidv7()}`);
    expect(bill.venue).toEqual(enriched);
  });
});
