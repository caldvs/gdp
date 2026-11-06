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

describe('cardLabel (#228)', () => {
  it('names the saved card', async () => {
    const { cardLabel } = await import('./useTableFee');
    expect(cardLabel({ brand: 'visa', last4: '4417' })).toBe('Visa ending 4417');
    expect(cardLabel({ brand: 'visa', last4: '4417', wallet: 'apple_pay' })).toBe('Apple Pay');
    expect(cardLabel({ brand: 'unionpay', last4: '1234' })).toBe('Card ending 1234');
    expect(cardLabel({})).toBe('Card');
  });
});
