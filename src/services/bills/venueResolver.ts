import type { Venue } from '../../types/bills.js';

/**
 * Resolves a free-text venue (typically the name/address Gemini extracts
 * from a bill image) to an enriched Venue with a stable placeId and
 * coordinates. Failure to enrich is not an error — implementations
 * return the input as-is (or undefined when there is nothing to return)
 * so a slow or missing geocoder never blocks a bill parse.
 */
export interface VenueResolver {
  resolve(input: { name?: string; address?: string }): Promise<Venue | undefined>;
}

/**
 * Identity resolver. Returns the input unchanged. Used when no API key
 * is configured (local dev / tests) so bills still carry whatever venue
 * text Gemini extracted, just without coordinates or placeId.
 */
export class NoopVenueResolver implements VenueResolver {
  resolve(input: { name?: string; address?: string }): Promise<Venue | undefined> {
    if (!input.name && !input.address) return Promise.resolve(undefined);
    return Promise.resolve({
      ...(input.name ? { name: input.name } : {}),
      ...(input.address ? { address: input.address } : {}),
    });
  }
}
