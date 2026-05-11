import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Venue } from '../types/bills.js';

const TTL_SECONDS = 90 * 24 * 60 * 60;

// Lowercase, trim, collapse internal whitespace. Joining name and
// address with `|` rather than a space ensures "Soho Square" + "London"
// can't collide with "" + "Soho Square London".
const normalize = (s: string | undefined): string =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const cacheKey = (input: { name?: string; address?: string }): string =>
  `${normalize(input.name)}|${normalize(input.address)}`;

const pk = (key: string) => `VENUEQ#${key}`;

interface CachedVenueRecord {
  // When Google had no match, we cache `null` so we don't re-query on
  // every duplicate-named bill. The bill still records the parsed text
  // separately — this only caches the *enrichment* result.
  venue: Venue | null;
}

export const venueCacheStore = {
  async get(key: string): Promise<CachedVenueRecord | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(key), sk: pk(key) },
      }),
    );
    if (!result.Item) return null;
    return { venue: (result.Item.venue ?? null) as Venue | null };
  },

  async put(key: string, record: CachedVenueRecord): Promise<void> {
    const ttlAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(key),
          sk: pk(key),
          venue: record.venue,
          ttlAt,
        },
      }),
    );
  },
};
