import { describe, it, expect } from 'vitest';
import { uuidv7 } from './idempotency';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces a well-formed UUIDv7 string', () => {
    expect(uuidv7()).toMatch(UUIDV7_RE);
  });

  it('produces unique values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(1000);
  });

  it('is monotonic-ish (later calls have >= timestamp)', () => {
    const a = uuidv7();
    const b = uuidv7();
    // First 12 hex chars encode the millisecond timestamp; b's should be >= a's.
    const tsA = a.replace(/-/g, '').slice(0, 12);
    const tsB = b.replace(/-/g, '').slice(0, 12);
    expect(BigInt('0x' + tsB)).toBeGreaterThanOrEqual(BigInt('0x' + tsA));
  });
});
