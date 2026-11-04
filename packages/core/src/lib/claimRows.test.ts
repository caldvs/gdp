import { describe, expect, it } from 'vitest';
import { claimRows, hasPaid } from './claimRows';

const bill = {
  billId: 'b1',
  items: [
    { itemId: 'bread', name: 'Garlic bread', unitPricePence: 150, quantity: 4, category: 'food' },
    { itemId: 'calamari', name: 'Calamari', unitPricePence: 2250, quantity: 1, category: 'food' },
    { itemId: 'lasagne', name: 'Lasagne', unitPricePence: 1725, quantity: 1, category: 'food' },
    { itemId: 'negroni', name: 'Negroni', unitPricePence: 1050, quantity: 2, category: 'drink' },
    { itemId: 'wine', name: 'Wine', unitPricePence: 2400, quantity: 1, category: 'drink' },
    { itemId: 'cake', name: 'Cake', unitPricePence: 700, quantity: 1, category: 'food' },
    { itemId: 'port', name: 'Port', unitPricePence: 900, quantity: 1, category: 'drink' },
    { itemId: 'tiramisu', name: 'Tiramisu', unitPricePence: 750, quantity: 1, category: 'food' },
  ],
} as never;

const unpaid = { status: 'unpaid' };
const session = {
  participants: [
    { userId: 'tom', claimedItemIds: ['bread', 'lasagne'], sharedItemIds: ['cake'], payment: unpaid },
    { userId: 'priya', claimedItemIds: ['bread', 'calamari', 'negroni'], sharedItemIds: ['wine', 'port'], payment: unpaid },
    { userId: 'sam', claimedItemIds: ['negroni', 'tiramisu'], sharedItemIds: ['wine', 'port'], payment: { status: 'pending', paymentId: 'x' } },
  ],
  shares: [
    { itemId: 'wine', userIds: ['priya', 'sam'], ways: 3, activity: [] },
    { itemId: 'cake', userIds: ['tom'], ways: 2, activity: [] },
    { itemId: 'port', userIds: ['priya', 'sam'], ways: 2, activity: [] },
  ],
} as never;

describe('claimRows', () => {
  const rows = claimRows(session, bill, 'tom');
  const row = (id: string) => rows.find((r) => r.item.itemId === id)!;

  it('puts each line in Yours, Still to claim or Claimed by others', () => {
    expect(rows.map((r) => [r.item.itemId, r.group, r.kind])).toEqual([
      ['bread', 'yours', 'multi'],
      ['calamari', 'others', 'single'],
      ['lasagne', 'yours', 'single'],
      ['negroni', 'others', 'multi'],
      ['wine', 'open', 'share'],
      ['cake', 'yours', 'share'],
      ['port', 'others', 'share'],
      ['tiramisu', 'others', 'single'],
    ]);
  });

  it('counts portions: mine, left and who else has some', () => {
    expect(row('bread')).toMatchObject({ mine: 1, left: 2 });
    expect(row('bread').others.map((p) => p.userId)).toEqual(['priya']);
    expect(row('negroni')).toMatchObject({ mine: 0, left: 0, canSplit: false });
    expect(row('wine')).toMatchObject({ mine: 0, left: 1, canSplit: false });
    expect(row('cake')).toMatchObject({ mine: 1, left: 1 });
  });

  it('offers Split on someone else’s dish until they have paid', () => {
    expect(row('calamari').canSplit).toBe(true);
    expect(row('tiramisu').canSplit).toBe(false);
    expect(row('port').canSplit).toBe(false);
    const priyaView = claimRows(session, bill, 'sam');
    expect(priyaView.find((r) => r.item.itemId === 'lasagne')!.canSplit).toBe(true);
  });

  it('skips people who have left a split', () => {
    const s = { participants: [], shares: [{ itemId: 'wine', userIds: ['gone'], ways: 2, activity: [] }] } as never;
    const r = claimRows(s, bill, 'tom').find((x) => x.item.itemId === 'wine')!;
    expect(r.others).toEqual([]);
    expect(r.group).toBe('open');
  });

  it('hasPaid is pending or succeeded', () => {
    expect(hasPaid({ payment: { status: 'succeeded' } } as never)).toBe(true);
    expect(hasPaid({ payment: { status: 'self_paid' } } as never)).toBe(false);
  });
});
