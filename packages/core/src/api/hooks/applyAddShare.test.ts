import { describe, expect, it } from 'vitest';
import { applyAddShare } from './useSession';

const base = {
  participants: [
    { userId: 'tom', claimedItemIds: ['rioja', 'calamari'], sharedItemIds: [] },
    { userId: 'priya', claimedItemIds: ['calamari2'], sharedItemIds: [] },
  ],
  shares: [],
} as never;

describe('applyAddShare (optimistic split)', () => {
  it('starts a split of some of a longer line without touching anyone’s claims', () => {
    const s = applyAddShare(base, 'rioja', 'tom', 3, 2);
    expect(s.shares).toEqual([{ itemId: 'rioja', userIds: ['tom'], ways: 3, units: 2, activity: [] }]);
    expect(s.participants[0]).toMatchObject({ claimedItemIds: ['rioja', 'calamari'], sharedItemIds: ['rioja'] });
  });

  it('turns a quantity-1 dish someone else claimed into a split with them (#130)', () => {
    const s = applyAddShare(base, 'calamari2', 'tom');
    expect(s.shares?.[0]).toMatchObject({ userIds: ['priya', 'tom'], ways: 2, units: 1 });
    expect(s.participants[1]).toMatchObject({ claimedItemIds: [], sharedItemIds: ['calamari2'] });
  });
});
