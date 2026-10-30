import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import type { VenueResolver } from '../../src/services/bills/venueResolver.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import {
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  uniqueImageBytes,
} from './helpers.js';
import type { Session } from '../../src/types/sessions.js';
import type { Venue } from '../../src/types/bills.js';

const enrichedVenue: Venue = {
  placeId: 'ChIJ-test-venue-id',
  name: 'Pizzeria Test',
  address: '1 Test Street, London W1F 0EF, UK',
  lat: 51.5135,
  lng: -0.1336,
};

const stubResolver: VenueResolver = {
  resolve: () => Promise.resolve(enrichedVenue),
};

const noVenueParser = new FixtureBillParser({
  ...sampleParsedBill,
  venue: undefined,
});

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    venueResolver: stubResolver,
  });

async function createBillAndSession(
  app: ReturnType<typeof buildApp>,
  userId: string,
): Promise<{ sessionId: string; billId: string }> {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: uniqueImageBytes(),
      ContentType: 'image/jpeg',
    }),
  );
  const parsed = await app.request('/v1/bills/parse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      ...makeAuth(userId),
    },
    body: JSON.stringify({ uploadId }),
  });
  const bill = (await parsed.json()) as { billId: string };

  const session = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(userId) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const sess = (await session.json()) as Session;
  return { sessionId: sess.sessionId, billId: bill.billId };
}

describe('Session response includes venue', () => {
  beforeAll(async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
    }
  });

  it('POST /v1/sessions returns venue copied from the pinned bill', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const uploadId = uuidv7();
    await s3.send(
      new PutObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: `${userId}/${uploadId}`,
        Body: uniqueImageBytes(),
        ContentType: 'image/jpeg',
      }),
    );
    const parsed = await app.request('/v1/bills/parse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(userId),
      },
      body: JSON.stringify({ uploadId }),
    });
    const bill = (await parsed.json()) as { billId: string };

    const created = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const session = (await created.json()) as Session;
    expect(session.venue).toEqual(enrichedVenue);
  });

  it('GET /v1/sessions/:id surfaces the venue', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const { sessionId } = await createBillAndSession(app, userId);

    const res = await app.request(`/v1/sessions/${sessionId}`, {
      headers: { ...makeAuth(userId) },
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as Session;
    expect(session.venue).toEqual(enrichedVenue);
  });

  it('omits venue when the parsed bill had none', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: noVenueParser,
      venueResolver: stubResolver,
    });
    const userId = `u-no-venue-${uuidv7()}`;
    const { sessionId } = await createBillAndSession(app, userId);

    const res = await app.request(`/v1/sessions/${sessionId}`, {
      headers: { ...makeAuth(userId) },
    });
    const session = (await res.json()) as Session;
    expect(session.venue).toBeUndefined();
  });
});
