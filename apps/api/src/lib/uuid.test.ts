import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('is a v7 UUID with the time in front, so ids sort by time', () => {
    const a = uuidv7(1_794_000_000_000);
    const b = uuidv7(1_794_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_794_000_000_000);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
