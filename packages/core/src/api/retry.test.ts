import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { retryUnlessClientError } from './retry';

const err = (status: number) => new ApiError(status, 'X', 'x');

describe('retryUnlessClientError', () => {
  it('never retries a 4xx the API meant', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(retryUnlessClientError(0, err(status))).toBe(false);
    }
  });

  it('retries timeouts, rate limits, server and network errors twice', () => {
    for (const e of [err(408), err(429), err(500), err(503), new TypeError('Failed to fetch')]) {
      expect(retryUnlessClientError(0, e)).toBe(true);
      expect(retryUnlessClientError(1, e)).toBe(true);
      expect(retryUnlessClientError(2, e)).toBe(false);
    }
  });
});
