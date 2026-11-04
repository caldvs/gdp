import { describe, expect, it } from 'vitest';
import { venueFromPlace } from './locationVenueResolver.js';
import { sameVenueName } from './venueResolver.js';

const bill = { name: 'Rudy’s Pizza', address: '9 Cotton Street, Manchester' };

describe('venueFromPlace', () => {
  const rudys = (Title: string, PlaceType = 'PointOfInterest') => ({
    PlaceId: 'p1',
    PlaceType,
    Title,
    Address: { Label: '9 Cotton Street, Manchester, M4 5BF, United Kingdom' },
    Position: [-2.2286, 53.4848],
  });

  it('takes the full address and coordinates of a place with exactly the bill’s name', () => {
    expect(venueFromPlace(rudys('RUDY’S PIZZA'), bill)).toEqual({
      placeId: 'p1',
      name: bill.name,
      address: '9 Cotton Street, Manchester, M4 5BF, United Kingdom',
      lat: 53.4848,
      lng: -2.2286,
    });
  });

  it('ignores a place whose name is anything else, however close', () => {
    expect(venueFromPlace(rudys('Rudy’s Neapolitan Pizza'), bill)).toBeUndefined();
    const caravan = { name: 'Caravan', address: '6 Goods Yard Street, Manchester M3 3BG' };
    expect(
      venueFromPlace(rudys('Greater Manchester Chamber Of Commerce'), caravan),
    ).toBeUndefined();
  });

  it('gives nothing for a bill with no name, or a match that is only an address', () => {
    expect(venueFromPlace(rudys('Rudy’s'), { address: bill.address })).toBeUndefined();
    expect(venueFromPlace(rudys('Rudy’s Pizza', 'PointAddress'), bill)).toBeUndefined();
  });

  it('rejects matches too vague to place a restaurant', () => {
    for (const PlaceType of ['Locality', 'PostalCode', 'Street', 'Country']) {
      expect(
        venueFromPlace({ PlaceId: 'p', PlaceType, Title: 'Rudy’s Pizza' }, bill),
      ).toBeUndefined();
    }
    expect(venueFromPlace(undefined, bill)).toBeUndefined();
    expect(
      venueFromPlace({ PlaceType: 'PointOfInterest', Title: 'Rudy’s Pizza' }, bill),
    ).toBeUndefined();
  });
});

describe('sameVenueName', () => {
  it('ignores case, apostrophes, spacing and & against "and" only', () => {
    expect(sameVenueName('Pot Kettle & Black', 'pot kettle and black')).toBe(true);
    expect(
      sameVenueName('d Maiora - Italian Sandwich Shop', 'D MAIORA ITALIAN SANDWICH SHOP'),
    ).toBe(true);
    expect(sameVenueName('Rudy’s', 'Rudys')).toBe(true);
    expect(sameVenueName('PKB', 'Pot Kettle Black')).toBe(false);
    expect(sameVenueName('', '')).toBe(false);
  });
});
