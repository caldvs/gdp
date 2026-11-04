import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import { FOOD_AND_DRINK, distanceM, parsePosition, roundCoord } from './nearbyVenues.js';

describe('distanceM', () => {
  it('is 0 for the same point', () => {
    expect(distanceM({ lat: 53.48, lng: -2.24 }, { lat: 53.48, lng: -2.24 })).toBe(0);
  });
  it('measures a known distance (about 111 m per 0.001° of latitude)', () => {
    expect(distanceM({ lat: 53.48, lng: -2.24 }, { lat: 53.481, lng: -2.24 })).toBe(111);
  });
  it('shrinks longitude with latitude', () => {
    // At 53.5°N a degree of longitude is about 0.595 of one at the equator.
    expect(distanceM({ lat: 53.48, lng: -2.24 }, { lat: 53.48, lng: -2.239 })).toBe(66);
  });
});

describe('roundCoord', () => {
  it('keeps 3 decimal places', () => {
    expect(roundCoord(53.480_95)).toBe(53.481);
    expect(roundCoord(-2.236_74)).toBe(-2.237);
  });
});

describe('parsePosition', () => {
  it('reads decimal coordinates', () => {
    expect(parsePosition('53.4808', '-2.2367')).toEqual({ lat: 53.4808, lng: -2.2367 });
    expect(parsePosition('90', '-180')).toEqual({ lat: 90, lng: -180 });
  });
  it.each([
    [undefined, '0'],
    ['53', undefined],
    ['', ''],
    ['91', '0'],
    ['0', '181'],
    ['abc', '0'],
    ['1e2', '0'],
    ['0x10', '0'],
    ['NaN', '0'],
    ['Infinity', '0'],
  ])('rejects lat=%s lng=%s', (lat, lng) => {
    expect(() => parsePosition(lat, lng)).toThrow(AppError);
  });
});

it('asks Amazon Location for at most 10 categories', () => {
  expect(FOOD_AND_DRINK.length).toBeLessThanOrEqual(10);
});
