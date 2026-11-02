/**
 * #62: GET /v1/venues/nearby, with a stubbed place search.
 */
import { describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import type { FoundPlace, NearbySearch } from '../../src/services/venues/nearbyVenues.js';
import { ddb, TABLE_NAME } from '../../src/storage/ddb.js';
import { fakeVerifier, makeAuth, sampleParsedBill } from './helpers.js';

type Body = { venues: { placeId: string; name: string; address?: string; distanceM: number }[] };

// A random spot well away from any other test's, so cached rows don't mix.
const spot = () => ({ lat: 50 + Math.random() * 5, lng: -5 + Math.random() * 4 });
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const keyOf = (at: { lat: number; lng: number }) =>
  `NEARQ#${r3(at.lat).toFixed(3)}|${r3(at.lng).toFixed(3)}`;

function stub(places: (at: { lat: number; lng: number }) => FoundPlace[]) {
  const calls: { lat: number; lng: number }[] = [];
  const search: NearbySearch = (at) => {
    calls.push(at);
    return Promise.resolve(places(at));
  };
  return { search, calls };
}

const build = (search: NearbySearch) =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    nearbySearch: search,
  });

const get = (app: ReturnType<typeof build>, query: string, user = `u-${uuidv7()}`) =>
  app.request(`/v1/venues/nearby${query}`, { headers: makeAuth(user) });

// `dLat` degrees north of `at`: 0.001° is about 111 m.
const place = (at: { lat: number; lng: number }, n: number, dLat: number): FoundPlace => ({
  placeId: `place-${n}`,
  name: `Place ${n}`,
  address: `${n} High St`,
  lat: at.lat + dLat,
  lng: at.lng,
});

describe('GET /v1/venues/nearby (#62)', () => {
  it('returns the five nearest, nearest first, measured from the caller', async () => {
    const at = spot();
    const { search, calls } = stub((c) =>
      // Out of order, seven of them.
      [5, 1, 7, 3, 2, 6, 4].map((n) => place(c, n, n * 0.0005)),
    );
    const res = await get(build(search), `?lat=${at.lat}&lng=${at.lng}`);
    expect(res.status).toBe(200);
    const { venues } = (await res.json()) as Body;
    expect(venues.map((v) => v.placeId)).toEqual([
      'place-1',
      'place-2',
      'place-3',
      'place-4',
      'place-5',
    ]);
    expect(venues[0]).toMatchObject({ name: 'Place 1', address: '1 High St' });
    for (let i = 1; i < venues.length; i += 1) {
      expect(venues[i]!.distanceM).toBeGreaterThanOrEqual(venues[i - 1]!.distanceM);
    }
    // The search was sent the rounded position, never the caller's own.
    expect(calls).toEqual([{ lat: r3(at.lat), lng: r3(at.lng) }]);
  });

  it('caches by the rounded position and never stores the caller’s own', async () => {
    const at = spot();
    const { search, calls } = stub((c) => [place(c, 1, 0.0002)]);
    const app = build(search);
    await get(app, `?lat=${at.lat}&lng=${at.lng}`);
    // A few metres away: same rounded cell, so no second search.
    const near = { lat: r3(at.lat) + 0.0001, lng: r3(at.lng) - 0.0001 };
    const second = await get(app, `?lat=${near.lat}&lng=${near.lng}`);
    expect(((await second.json()) as Body).venues).toHaveLength(1);
    expect(calls).toHaveLength(1);

    const row = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: keyOf(at), sk: keyOf(at) } }),
    );
    expect(row.Item).toBeDefined();
    expect(typeof row.Item!.ttlAt).toBe('number');
    const stored = JSON.stringify(row.Item);
    expect(stored).not.toContain(String(at.lat));
    expect(stored).not.toContain(String(at.lng));
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: keyOf(at), sk: keyOf(at) } }),
    );
  });

  it('returns an empty list when nothing is near', async () => {
    const at = spot();
    const res = await get(build(stub(() => []).search), `?lat=${at.lat}&lng=${at.lng}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ venues: [] });
  });

  it('returns an empty list when the search fails, and tries again next time', async () => {
    const at = spot();
    let fail = true;
    const search: NearbySearch = (c) =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve([place(c, 1, 0.0001)]);
    const app = build(search);
    const first = await get(app, `?lat=${at.lat}&lng=${at.lng}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ venues: [] });
    fail = false;
    const second = await get(app, `?lat=${at.lat}&lng=${at.lng}`);
    expect(((await second.json()) as Body).venues).toHaveLength(1);
  });

  it.each(['', '?lat=53.48', '?lng=-2.24', '?lat=91&lng=0', '?lat=0&lng=-181', '?lat=x&lng=y'])(
    'rejects bad coordinates (%s) with 400',
    async (query) => {
      const { search, calls } = stub(() => []);
      const res = await get(build(search), query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    },
  );

  it('needs a signed-in caller', async () => {
    const res = await build(stub(() => []).search).request('/v1/venues/nearby?lat=53.48&lng=-2.24');
    expect(res.status).toBe(401);
  });
});
