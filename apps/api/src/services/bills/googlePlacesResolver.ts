import { z } from 'zod';
import type { Venue } from '../../types/bills.js';
import type { VenueResolver } from './venueResolver.js';
import { cacheKey, venueCacheStore } from '../../storage/venueCacheStore.js';
import type { Logger } from '../../logging/logger.js';
import { timed } from '../../logging/timed.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
// Keep the field mask tight: more fields = higher SKU tier = more $.
// id + displayName + formattedAddress + location keeps us in the
// cheapest "Text Search (ID Only)" + "Basic" tier combo.
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location';

const PlacesResponseSchema = z.object({
  places: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.object({ text: z.string() }).optional(),
        formattedAddress: z.string().optional(),
        location: z
          .object({
            latitude: z.number(),
            longitude: z.number(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export interface GooglePlacesResolverConfig {
  apiKey: string;
  // Region bias improves match quality for ambiguous names. Defaults
  // to the UK because that's our v0 market; pass a different code if
  // we ever expand.
  regionCode?: string;
  logger?: Logger;
}

export class GooglePlacesVenueResolver implements VenueResolver {
  constructor(private readonly config: GooglePlacesResolverConfig) {}

  async resolve(input: { name?: string; address?: string }): Promise<Venue | undefined> {
    const query = [input.name, input.address].filter(Boolean).join(' ').trim();
    if (!query) return undefined;

    const key = cacheKey(input);
    const cached = await venueCacheStore.get(key).catch((err: unknown) => {
      this.config.logger?.warn({ err, key }, 'venue cache get failed; treating as miss');
      return null;
    });
    if (cached) return cached.venue ?? this.fallback(input);

    const resolved = await this.search(query).catch((err: unknown) => {
      this.config.logger?.warn(
        { err, query },
        'Google Places lookup failed; falling back to parsed text',
      );
      return undefined;
    });

    // Cache the *enrichment* result. A null cache entry means "Google
    // had no match" — we still serve the parsed text via fallback() but
    // don't re-query Google for the same input within the TTL.
    await venueCacheStore.put(key, { venue: resolved ?? null }).catch((err: unknown) => {
      this.config.logger?.warn({ err, key }, 'venue cache put failed; cache miss next time');
    });

    return resolved ?? this.fallback(input);
  }

  private async search(textQuery: string): Promise<Venue | undefined> {
    const res = await timed('places', 'searchText', () =>
      fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.apiKey,
          'x-goog-fieldmask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery,
          regionCode: this.config.regionCode ?? 'GB',
          maxResultCount: 1,
        }),
      }),
    );
    if (!res.ok) {
      // Google's body says why (API not enabled, key restricted, billing).
      const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Places returned ${res.status}: ${why}`);
    }

    const json: unknown = await res.json();
    const parsed = PlacesResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('Places response failed schema validation');
    }

    const top = parsed.data.places?.[0];
    if (!top) return undefined;

    return {
      placeId: top.id,
      ...(top.displayName?.text ? { name: top.displayName.text } : {}),
      ...(top.formattedAddress ? { address: top.formattedAddress } : {}),
      ...(top.location ? { lat: top.location.latitude, lng: top.location.longitude } : {}),
    };
  }

  private fallback(input: { name?: string; address?: string }): Venue | undefined {
    if (!input.name && !input.address) return undefined;
    return {
      ...(input.name ? { name: input.name } : {}),
      ...(input.address ? { address: input.address } : {}),
    };
  }
}
