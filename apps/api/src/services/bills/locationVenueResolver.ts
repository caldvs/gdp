import { GeoPlacesClient, SearchTextCommand } from '@aws-sdk/client-geo-places';
import type { Venue } from '../../types/bills.js';
import type { VenueResolver } from './venueResolver.js';
import { cacheKey, venueCacheStore } from '../../storage/venueCacheStore.js';
import type { Logger } from '../../logging/logger.js';
import { timed } from '../../logging/timed.js';

/** Great Britain and Northern Ireland: [west, south, east, north]. */
const UK_BOUNDS = [-8.65, 49.86, 1.77, 60.86];

/** Matches precise enough to name a restaurant's location. */
const PRECISE = new Set([
  'PointOfInterest',
  'PointAddress',
  'InterpolatedAddress',
  'SecondaryAddress',
]);

/** One SearchText result, as much of it as we use. */
export type PlaceResult = {
  PlaceId?: string;
  PlaceType?: string;
  Title?: string;
  Address?: { Label?: string };
  Position?: number[];
};

/** Runs one search. Swappable so tests don't call AWS. */
export type PlaceSearch = (query: string) => Promise<PlaceResult | undefined>;

export const amazonLocationSearch = (region: string): PlaceSearch => {
  const client = new GeoPlacesClient({ region });
  return async (query) => {
    const out = await timed('location', 'searchText', () =>
      client.send(
        new SearchTextCommand({
          QueryText: query,
          Filter: { BoundingBox: UK_BOUNDS, IncludeCountries: ['GBR'] },
          MaxResults: 1,
          // Results are cached and stored on bills; Amazon Location's terms
          // require Storage for that (billed at a higher rate than SingleUse).
          IntendedUse: 'Storage',
          Language: 'en',
        }),
      ),
    );
    return out.ResultItems?.[0];
  };
};

/** A result as a Venue, or undefined when it's too vague to trust. */
export function venueFromPlace(
  place: PlaceResult | undefined,
  input: { name?: string; address?: string },
): Venue | undefined {
  if (!place?.PlaceId || !place.PlaceType || !PRECISE.has(place.PlaceType)) return undefined;
  const [lng, lat] = place.Position ?? [];
  // A point of interest's title is the business name; an address match's
  // title is the address, so keep the name printed on the bill.
  const name = place.PlaceType === 'PointOfInterest' ? (place.Title ?? input.name) : input.name;
  const address = place.Address?.Label ?? input.address;
  return {
    placeId: place.PlaceId,
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : {}),
  };
}

/**
 * Looks up the venue Bedrock read off the bill with Amazon Location Service
 * (Places v2) to fill in a full address and coordinates. Answers are cached
 * without expiry (venueCacheStore). Never fails a bill: on any error, or no
 * precise match, the venue is the text read off the bill.
 */
export class AmazonLocationVenueResolver implements VenueResolver {
  constructor(
    private readonly search: PlaceSearch,
    private readonly logger?: Logger,
  ) {}

  async resolve(input: { name?: string; address?: string }): Promise<Venue | undefined> {
    const query = [input.name, input.address].filter(Boolean).join(', ').trim();
    if (!query) return undefined;

    const key = cacheKey(input);
    const cached = await venueCacheStore.get(key).catch((err: unknown) => {
      this.logger?.warn({ err, key }, 'venue cache get failed; treating as miss');
      return null;
    });
    if (cached) return cached.venue ?? fromBill(input);

    let found: Venue | undefined;
    try {
      found = venueFromPlace(await this.search(query), input);
    } catch (err) {
      // Not cached: a failed lookup is tried again next time.
      this.logger?.warn({ err, query }, 'venue lookup failed; using the text on the bill');
      return fromBill(input);
    }

    await venueCacheStore.put(key, { venue: found ?? null }).catch((err: unknown) => {
      this.logger?.warn({ err, key }, 'venue cache put failed; cache miss next time');
    });
    return found ?? fromBill(input);
  }
}

function fromBill(input: { name?: string; address?: string }): Venue | undefined {
  if (!input.name && !input.address) return undefined;
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.address ? { address: input.address } : {}),
  };
}
