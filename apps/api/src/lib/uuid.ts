import { randomBytes } from 'node:crypto';

/**
 * A version 7 UUID (RFC 9562): 48 bits of Unix milliseconds, then random
 * bits. Time-ordered, so ids sort by when they were made (comments, rows).
 * Replaces the `uuid` package; Node only has v4 built in.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
