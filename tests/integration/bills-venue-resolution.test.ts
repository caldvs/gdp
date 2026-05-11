import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import {
  GooglePlacesVenueResolver,
  type GooglePlacesResolverConfig,
} from '../../src/services/bills/googlePlacesResolver.js';
import { NoopVenueResolver, type VenueResolver } from '../../src/services/bills/venueResolver.js';
import { cacheKey, venueCacheStore } from '../../src/storage/venueCacheStore.js';
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

  describe('GooglePlacesVenueResolver against a stubbed Places API', () => {
    function buildResolverWithFetch(
      fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
      cfgOverrides: Partial<GooglePlacesResolverConfig> = {},
    ): { resolver: GooglePlacesVenueResolver; fetchSpy: ReturnType<typeof vi.fn> } {
      const fetchSpy = vi.fn(fetchImpl);
      vi.stubGlobal('fetch', fetchSpy);
      const resolver = new GooglePlacesVenueResolver({ apiKey: 'fake-key', ...cfgOverrides });
      return { resolver, fetchSpy };
    }

    it('calls Places once, caches result, serves second lookup from cache', async () => {
      const placesResponse = {
        places: [
          {
            id: 'ChIJ-real-456',
            displayName: { text: 'Honest Burgers Soho' },
            formattedAddress: '4a Meard St, London W1F 0EF, UK',
            location: { latitude: 51.5135, longitude: -0.1336 },
          },
        ],
      };
      const { resolver, fetchSpy } = buildResolverWithFetch(() =>
        Promise.resolve(new Response(JSON.stringify(placesResponse), { status: 200 })),
      );

      const input = { name: `Honest Burgers ${uuidv7()}`, address: 'Soho' };
      const first = await resolver.resolve(input);
      const second = await resolver.resolve(input);

      expect(first?.placeId).toBe('ChIJ-real-456');
      expect(first?.lat).toBe(51.5135);
      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const cached = await venueCacheStore.get(cacheKey(input));
      expect(cached?.venue?.placeId).toBe('ChIJ-real-456');

      vi.unstubAllGlobals();
    });

    it('caches negative results so unmatched queries do not re-hit Places', async () => {
      const { resolver, fetchSpy } = buildResolverWithFetch(() =>
        Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
      );

      const input = { name: `Nowhere ${uuidv7()}`, address: 'Atlantis' };
      const first = await resolver.resolve(input);
      const second = await resolver.resolve(input);

      // Google had no match → resolver falls back to the parsed text on
      // both calls, but only hits Places once.
      expect(first).toEqual({ name: input.name, address: input.address });
      expect(second).toEqual(first);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const cached = await venueCacheStore.get(cacheKey(input));
      expect(cached?.venue).toBeNull();

      vi.unstubAllGlobals();
    });

    it('on Places failure: returns parsed text fallback (does not throw)', async () => {
      const { resolver, fetchSpy } = buildResolverWithFetch(() =>
        Promise.resolve(new Response('boom', { status: 500 })),
      );

      const input = { name: `Crashy ${uuidv7()}`, address: 'Somewhere' };
      const result = await resolver.resolve(input);

      expect(result).toEqual({ name: input.name, address: input.address });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });
});
