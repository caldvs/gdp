import { describe, expect, it } from 'vitest';
import { venueFromPlace } from './locationVenueResolver.js';

const bill = { name: 'Rudy’s Pizza', address: '9 Cotton Street, Manchester' };

describe('venueFromPlace', () => {
  it('takes a point of interest’s full address and coordinates, keeping the bill’s name', () => {
    expect(
      venueFromPlace(
        {
          PlaceId: 'p1',
          PlaceType: 'PointOfInterest',
          Title: 'Rudy’s Neapolitan Pizza',
          Address: { Label: '9 Cotton Street, Manchester, M4 5BF, United Kingdom' },
          Position: [-2.2286, 53.4848],
        },
        bill,
      ),
    ).toEqual({
      placeId: 'p1',
      name: bill.name,
      address: '9 Cotton Street, Manchester, M4 5BF, United Kingdom',
      lat: 53.4848,
      lng: -2.2286,
    });
  });

  it('never names the venue after another business in the same building (#175)', () => {
    const caravan = { name: 'Caravan', address: '6 Goods Yard Street, Manchester M3 3BG' };
    expect(
      venueFromPlace(
        {
          PlaceId: 'p3',
          PlaceType: 'PointOfInterest',
          Title: 'Greater Manchester Chamber Of Commerce',
          Address: { Label: '6 Goods Yard Street, Manchester, M3 3BG, United Kingdom' },
        },
        caravan,
      )?.name,
    ).toBe('Caravan');
  });

  it('names the venue from a point of interest only when the bill has no name', () => {
    expect(
      venueFromPlace(
        { PlaceId: 'p4', PlaceType: 'PointOfInterest', Title: 'Rudy’s', Address: {} },
        { address: bill.address },
      )?.name,
    ).toBe('Rudy’s');
  });

  it('keeps the bill’s name when the match is an address', () => {
    expect(
      venueFromPlace(
        { PlaceId: 'p2', PlaceType: 'PointAddress', Title: '9 Cotton Street', Address: {} },
        bill,
      ),
    ).toEqual({ placeId: 'p2', name: bill.name, address: bill.address });
  });

  it('rejects matches too vague to place a restaurant', () => {
    for (const PlaceType of ['Locality', 'PostalCode', 'Street', 'Country']) {
      expect(
        venueFromPlace({ PlaceId: 'p', PlaceType, Title: 'Manchester' }, bill),
      ).toBeUndefined();
    }
    expect(venueFromPlace(undefined, bill)).toBeUndefined();
    expect(venueFromPlace({ PlaceType: 'PointOfInterest' }, bill)).toBeUndefined();
  });
});
