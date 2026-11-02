import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { FoundPlace } from '../services/venues/nearbyVenues.js';

/**
 * Nearby food and drink places (#62), cached by a position rounded to 3
 * decimal places (about 110 m), as `NEARQ#<lat>|<lng>` rows. The key is the
 * rounded point, never the caller's own position, and no row says who asked.
 * Kept 30 days: places open and close, unlike a venue looked up by name
 * (venueCacheStore, kept for good).
 */
const TTL_DAYS = 30;

export const nearbyCacheKey = (at: { lat: number; lng: number }): string =>
  `${at.lat.toFixed(3)}|${at.lng.toFixed(3)}`;

const pk = (key: string) => `NEARQ#${key}`;

export const nearbyCacheStore = {
  async get(key: string): Promise<FoundPlace[] | null> {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: pk(key), sk: pk(key) } }),
    );
    if (!result.Item) return null;
    return (result.Item.places ?? []) as FoundPlace[];
  },

  async put(key: string, places: FoundPlace[]): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(key),
          sk: pk(key),
          places,
          cachedAt: new Date().toISOString(),
          ttlAt: Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 60 * 60,
        },
      }),
    );
  },
};
