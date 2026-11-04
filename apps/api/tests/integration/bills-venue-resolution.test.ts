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
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../../src/storage/ddb.js';
import { cacheKey } from '../../src/storage/venueCacheStore.js';
import {
  AmazonLocationVenueResolver,
  type PlaceResult,
} from '../../src/services/bills/locationVenueResolver.js';

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

describe('AmazonLocationVenueResolver (fake search, real cache)', () => {
  const place: PlaceResult = {
    PlaceId: 'loc-1',
    PlaceType: 'PointOfInterest',
    Title: 'Test Kitchen',
    Address: { Label: '1 Test Street, Manchester, M4 1AA, United Kingdom' },
    Position: [-2.23, 53.48],
  };
  const counting = (answer: () => Promise<PlaceResult | undefined>) => {
    const search = Object.assign(() => (search.calls++, answer()), { calls: 0 });
    return search;
  };
  const row = async (input: { name?: string; address?: string }) =>
    (
      await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: `VENUEQ#${cacheKey(input)}`, sk: `VENUEQ#${cacheKey(input)}` },
        }),
      )
    ).Item;

  it('looks a venue up once, then serves it from a cache row with no TTL', async () => {
    const input = { name: `Test Kitchen ${uuidv7()}`, address: '1 Test Street' };
    const search = counting(() => Promise.resolve(place));
    const resolver = new AmazonLocationVenueResolver(search);
    const first = await resolver.resolve(input);
    const second = await resolver.resolve(input);
    expect(first).toEqual({
      placeId: 'loc-1',
      name: input.name,
      address: '1 Test Street, Manchester, M4 1AA, United Kingdom',
      lat: 53.48,
      lng: -2.23,
    });
    expect(second).toEqual(first);
    expect(search.calls).toBe(1);
    const item = await row(input);
    expect(item?.source).toBe('amazon-location');
    expect(item?.ttlAt).toBeUndefined();
  });

  it('caches "no precise match" so the same text isn’t looked up again', async () => {
    const input = { name: `Nowhere ${uuidv7()}` };
    const search = counting(() => Promise.resolve({ PlaceId: 'x', PlaceType: 'Locality' }));
    const resolver = new AmazonLocationVenueResolver(search);
    expect(await resolver.resolve(input)).toEqual({ name: input.name });
    expect(await resolver.resolve(input)).toEqual({ name: input.name });
    expect(search.calls).toBe(1);
  });

  it('doesn’t cache a failed lookup', async () => {
    const input = { name: `Flaky ${uuidv7()}` };
    const search = counting(() => Promise.reject(new Error('throttled')));
    const resolver = new AmazonLocationVenueResolver(search);
    expect(await resolver.resolve(input)).toEqual({ name: input.name });
    expect(await resolver.resolve(input)).toEqual({ name: input.name });
    expect(search.calls).toBe(2);
    expect(await row(input)).toBeUndefined();
  });

  it('serves a cached row under the bill’s name, not the looked-up one (#175)', async () => {
    const input = { name: `Caravan ${uuidv7()}`, address: '6 Goods Yard Street' };
    const key = `VENUEQ#${cacheKey(input)}`;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: key,
          sk: key,
          source: 'amazon-location',
          venue: { placeId: 'loc-2', name: 'Greater Manchester Chamber Of Commerce' },
        },
      }),
    );
    const search = counting(() => Promise.resolve(place));
    const venue = await new AmazonLocationVenueResolver(search).resolve(input);
    expect(venue).toEqual({ placeId: 'loc-2', name: input.name });
    expect(search.calls).toBe(0);
  });

  it('replaces an old Google Places row, dropping its TTL', async () => {
    const input = { name: `Old Row ${uuidv7()}`, address: '2 Test Street' };
    const key = `VENUEQ#${cacheKey(input)}`;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: key, sk: key, venue: { placeId: 'ChIJ-google' }, ttlAt: 2_000_000_000 },
      }),
    );
    const search = counting(() => Promise.resolve(place));
    const venue = await new AmazonLocationVenueResolver(search).resolve(input);
    expect(venue?.placeId).toBe('loc-1');
    expect(search.calls).toBe(1);
    const item = await row(input);
    expect(item?.source).toBe('amazon-location');
    expect(item?.ttlAt).toBeUndefined();
  });
});
