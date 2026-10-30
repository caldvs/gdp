import { describe, expect, it } from 'vitest';
import { isLikelyShareable } from './shareability';

const item = (name: string, quantity = 1, category: 'food' | 'drink' = 'food') => ({ name, quantity, category });

describe('isLikelyShareable', () => {
  it.each(['House Red Bottle', 'Carafe of white', 'Cheeseboard', 'Cheese board', 'Mezze platter', 'Nachos to share', 'Sharing fries', 'Chateaubriand for two', 'Paella for 2', 'Bao bun set'])(
    '%s → yes',
    (name) => expect(isLikelyShareable(item(name))).toBe(true),
  );

  it.each(['Glass of house red', 'Fries', 'Bottled water', 'Cod and chips', 'Pinto beans'])('%s → no', (name) =>
    expect(isLikelyShareable(item(name))).toBe(false),
  );

  it('never for multi-quantity lines (those are claimed per unit)', () => {
    expect(isLikelyShareable(item('Bottle of prosecco', 2, 'drink'))).toBe(false);
  });
});
