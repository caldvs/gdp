import { describe, it, expect } from 'vitest';
import { ApiError } from '../index';
import { creditDate } from './useTableFee';
import { isFeeRequired } from './useSession';

describe('creditDate', () => {
  it('reads the 1st of next month as "1 Dec"', () => {
    expect(creditDate('2026-12-01')).toBe('1 Dec');
    expect(creditDate('2027-01-01')).toBe('1 Jan');
  });
});

describe('isFeeRequired', () => {
  it('spots the API asking for the platform fee', () => {
    expect(isFeeRequired(new ApiError(402, 'TABLE_FEE_REQUIRED', 'Pay the fee'))).toBe(true);
    expect(isFeeRequired(new ApiError(409, 'SESSION_INVALID_STATE', 'x'))).toBe(false);
    expect(isFeeRequired(new Error('x'))).toBe(false);
  });
});
