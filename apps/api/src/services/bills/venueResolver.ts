import type { Venue } from '../../types/bills.js';

/**
 * Turns the venue read off the bill (name and address, from Bedrock) into
 * the bill's Venue. The app uses NoopVenueResolver: the venue is what's
 * printed on the bill. Tests inject resolvers to cover enrichment
 * (placeId, coordinates), which old bills may still carry.
 */
export interface VenueResolver {
  resolve(input: { name?: string; address?: string }): Promise<Venue | undefined>;
}

/**
 * Identity resolver. Returns the venue as read off the bill.
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
