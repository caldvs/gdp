import { describe, expect, it } from 'vitest';
import { venueFromPlace } from './locationVenueResolver.js';

const bill = { name: 'Rudy’s Pizza', address: '9 Cotton Street, Manchester' };

describe('venueFromPlace', () => {
  it('takes a point of interest’s name, full address and coordinates', () => {
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
      name: 'Rudy’s Neapolitan Pizza',
      address: '9 Cotton Street, Manchester, M4 5BF, United Kingdom',
      lat: 53.4848,
      lng: -2.2286,
    });
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
