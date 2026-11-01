import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Venue } from '../types/bills.js';

/**
 * Venue lookups, cached for good: `VENUEQ#<key>` rows have no TTL (Callum's
 * call, 1 Nov 2026). Amazon Location Service is queried with
 * IntendedUse=Storage, which its terms require for results we keep.
 *
 * Rows written before 1 Nov 2026 hold Google Places answers and carry a
 * TTL. They're treated as misses (no `source`), so the next lookup
 * replaces them with an Amazon Location answer and drops the TTL.
 */

export const VENUE_SOURCE = 'amazon-location';

// Lowercase, trim, collapse internal whitespace. Joining name and
// address with `|` rather than a space ensures "Soho Square" + "London"
// can't collide with "" + "Soho Square London".
const normalize = (s: string | undefined): string =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const cacheKey = (input: { name?: string; address?: string }): string =>
  `${normalize(input.name)}|${normalize(input.address)}`;

const pk = (key: string) => `VENUEQ#${key}`;

export interface CachedVenueRecord {
  // `null` when Amazon Location had no good match, so the same text isn't
  // looked up again. The bill still records the text read off it.
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
    if (!result.Item || result.Item.source !== VENUE_SOURCE) return null;
    return { venue: (result.Item.venue ?? null) as Venue | null };
  },

  async put(key: string, record: CachedVenueRecord): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(key),
          sk: pk(key),
          source: VENUE_SOURCE,
          venue: record.venue,
          cachedAt: new Date().toISOString(),
        },
      }),
    );
  },
};
