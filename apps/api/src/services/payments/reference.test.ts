import { describe, expect, it } from 'vitest';
import { REFERENCE_MAX, paymentReference } from './reference.js';

describe('paymentReference', () => {
  it('is the venue and the guest’s first name', () => {
    expect(paymentReference('Gennaro', 'Tom Baker')).toBe('Gennaro Tom');
  });
  it('fits 18 characters with whole words of the venue, never cutting the name', () => {
    const ref = paymentReference('The Dog & Partridge Free House', 'Alexandra');
    expect(ref).toBe('Dog and Alexandra');
    expect(paymentReference('Gennaro', 'Maximiliana-Josephine')).toBe('Maximiliana');
    expect(ref.length).toBeLessThanOrEqual(REFERENCE_MAX);
  });
  it('keeps letters, digits and spaces only', () => {
    expect(paymentReference('Café Rouge #2', 'Zoë')).toBe('Cafe Rouge 2 Zoe');
  });
  it('falls back when there’s no venue or name', () => {
    expect(paymentReference(undefined, 'Tom')).toBe('Tom');
    expect(paymentReference('Gennaro', undefined)).toBe('Gennaro');
    expect(paymentReference(undefined, undefined)).toBe('Pay Me Back');
  });
});
