import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../src/errors/AppError.js';
import type { IdTokenVerifier } from '../../src/services/auth.js';
import type { ParsedBillFromImage } from '../../src/services/bills/parser.js';

/**
 * Returns bytes whose SHA-256 is unique per call, so tests don't collide
 * with the bill image-hash dedupe index from previous runs.
 */
export const uniqueImageBytes = (): Uint8Array =>
  new TextEncoder().encode(`fixture-${uuidv7()}-${Math.random()}`);

/**
 * Token format: `tok-<userId>` returns a verified identity for that user.
 * Token `expired-token` throws AUTH_EXPIRED.
 * Anything else throws AUTH_INVALID.
 */
export const fakeVerifier: IdTokenVerifier = (token) => {
  if (token === 'expired-token') return Promise.reject(new AppError('AUTH_EXPIRED', 'expired'));
  if (token.startsWith('tok-')) {
    const userId = token.slice('tok-'.length);
    return Promise.resolve({
      userId,
      email: `${userId}@example.com`,
      name: userId,
    });
  }
  return Promise.reject(new AppError('AUTH_INVALID', 'invalid'));
};

export const makeAuth = (userId: string): { authorization: string } => ({
  authorization: `Bearer tok-${userId}`,
});

export const newIdempotencyKey = (): string => uuidv7();

export const sampleParsedBill: ParsedBillFromImage = {
  items: [
    { name: 'Margherita Pizza', unitPricePence: 1450, quantity: 2, category: 'food' },
    { name: 'Pint of IPA', unitPricePence: 650, quantity: 3, category: 'drink' },
    { name: 'Tiramisu', unitPricePence: 750, quantity: 1, category: 'food' },
  ],
  taxPence: 0, // VAT typically baked in for UK menu prices
  serviceChargePence: 575, // 12.5% on 4600 subtotal = 575
  totalPence: 5175,
  currency: 'GBP',
  venue: { name: 'Pizzeria Test', address: '1 Test Street, London' },
};
