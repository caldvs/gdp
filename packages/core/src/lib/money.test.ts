import { describe, it, expect } from 'vitest';
import { formatGBP } from './money';

describe('formatGBP', () => {
  it('formats whole pounds', () => {
    expect(formatGBP(1000)).toBe('£10.00');
  });

  it('formats fractional pounds with two decimals', () => {
    expect(formatGBP(1234)).toBe('£12.34');
  });

  it('formats single pence correctly', () => {
    expect(formatGBP(1)).toBe('£0.01');
  });

  it('formats zero', () => {
    expect(formatGBP(0)).toBe('£0.00');
  });

  it('formats large values without losing precision', () => {
    expect(formatGBP(1234567)).toBe('£12,345.67');
  });

  it('rejects non-integer pence', () => {
    expect(() => formatGBP(12.5)).toThrow(/integer pence/);
  });
});
