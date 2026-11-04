import { GeoPlacesClient, SearchNearbyCommand } from '@aws-sdk/client-geo-places';
import { AppError } from '../../errors/AppError.js';
import type { Logger } from '../../logging/logger.js';
import { timed } from '../../logging/timed.js';
import { nearbyCacheKey, nearbyCacheStore } from '../../storage/nearbyCacheStore.js';

/** A food or drink place near the lead, for the scan screen (#62). */
export type NearbyVenue = {
  placeId: string;
  name: string;
  address?: string;
  distanceM: number;
};

/** A place as found, before distances are measured from the caller. */
export type FoundPlace = {
  placeId: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
};

/** Finds food and drink places around a point. Swappable so tests don't call AWS. */
export type NearbySearch = (at: { lat: number; lng: number }) => Promise<FoundPlace[]>;

export const NEARBY_LIMIT = 5;
/** How far to look, in metres. A table is somewhere the lead is standing. */
export const NEARBY_RADIUS_M = 300;

/**
 * Amazon Location's food and drink categories (at most 10 per request).
 * https://docs.aws.amazon.com/location/latest/developerguide/places-filtering.html
 */
export const FOOD_AND_DRINK = [
  'restaurant',
  'casual_dining',
  'fine_dining',
  'fast_food',
  'bistro',
  'coffee_shop',
  'bar_or_pub',
  'cocktail_lounge',
  'beer_garden',
  'deli',
];

export const amazonLocationNearby = (region: string): NearbySearch => {
  const client = new GeoPlacesClient({ region });
  return async ({ lat, lng }) => {
    const out = await timed('location', 'searchNearby', () =>
      client.send(
        new SearchNearbyCommand({
          QueryPosition: [lng, lat],
          QueryRadius: NEARBY_RADIUS_M,
          MaxResults: 20,
          Filter: { IncludeCategories: FOOD_AND_DRINK },
          // Results are cached; Amazon Location's terms require Storage for that.
          IntendedUse: 'Storage',
          Language: 'en',
        }),
      ),
    );
    const found: FoundPlace[] = [];
    for (const r of out.ResultItems ?? []) {
      const [pLng, pLat] = r.Position ?? [];
      if (!r.PlaceId || !r.Title || typeof pLat !== 'number' || typeof pLng !== 'number') continue;
      found.push({
        placeId: r.PlaceId,
        name: r.Title,
        ...(r.Address?.Label ? { address: r.Address.Label } : {}),
        lat: pLat,
        lng: pLng,
      });
    }
    return found;
  };
};

/** With VENUE_LOOKUP=none (tests, CI) there are no nearby places; the app asks for a name. */
export const noNearby: NearbySearch = () => Promise.resolve([]);

/** Metres between two points (haversine). */
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Rounds a coordinate to 3 places (about 110 m): the most we cache or log. */
export const roundCoord = (n: number): number => Math.round(n * 1000) / 1000;

/** Parses `lat`/`lng` query values; 400 unless both are real coordinates. */
export function parsePosition(
  lat: string | undefined,
  lng: string | undefined,
): { lat: number; lng: number } {
  const num = (s: string | undefined) =>
    s !== undefined && /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : NaN;
  const la = num(lat);
  const ln = num(lng);
  if (!(la >= -90 && la <= 90) || !(ln >= -180 && ln <= 180)) {
    throw new AppError('INVALID_INPUT', 'lat and lng must be coordinates');
  }
  return { lat: la, lng: ln };
}

/**
 * Up to five food and drink places nearest the caller. Searches around the
 * rounded position and caches by it (nearbyCacheStore), then measures each
 * place from the real position. The caller's position is never stored, and
 * logged only rounded. A failed search returns nothing: the app then asks
 * for the venue's name instead.
 */
export function createNearbyVenueService(deps: { search: NearbySearch; logger?: Logger }) {
  return {
    async nearby(at: { lat: number; lng: number }): Promise<NearbyVenue[]> {
      const centre = { lat: roundCoord(at.lat), lng: roundCoord(at.lng) };
      const key = nearbyCacheKey(centre);
      let places = await nearbyCacheStore.get(key).catch((err: unknown) => {
        deps.logger?.warn({ err, at: centre }, 'nearby cache get failed; treating as miss');
        return null;
      });
      if (!places) {
        try {
          places = await deps.search(centre);
        } catch (err) {
          deps.logger?.warn({ err, at: centre }, 'nearby search failed');
          return [];
        }
        await nearbyCacheStore.put(key, places).catch((err: unknown) => {
          deps.logger?.warn({ err, at: centre }, 'nearby cache put failed');
        });
      }
      return places
        .map((p) => ({
          placeId: p.placeId,
          name: p.name,
          ...(p.address ? { address: p.address } : {}),
          distanceM: distanceM(at, p),
        }))
        .sort((a, b) => a.distanceM - b.distanceM || a.name.localeCompare(b.name))
        .slice(0, NEARBY_LIMIT);
    },
  };
}
export type NearbyVenueService = ReturnType<typeof createNearbyVenueService>;
