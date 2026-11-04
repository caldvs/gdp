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

/**
 * Whether two place names are the same name, the way a person reads them:
 * case, apostrophes, spacing, punctuation and "&"/"and" aside. Nothing
 * looser: "Rudy’s Pizza" is not "Rudy’s Neapolitan Pizza".
 */
export function sameVenueName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/['’‘`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return norm(a) !== '' && norm(a) === norm(b);
}
