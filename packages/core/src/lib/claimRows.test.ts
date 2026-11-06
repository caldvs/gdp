import { describe, expect, it } from 'vitest';
import { claimPortions, claimRows, hasPaid } from './claimRows';

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

describe('claimRows: a split covering some of a longer line', () => {
  const b = {
    billId: 'b2',
    items: [{ itemId: 'rioja', name: 'Rioja', unitPricePence: 2400, quantity: 4, category: 'drink' }],
  } as never;
  const s = {
    participants: [
      { userId: 'tom', claimedItemIds: ['rioja'], sharedItemIds: ['rioja'], payment: unpaid },
      { userId: 'priya', claimedItemIds: [], sharedItemIds: ['rioja'], payment: unpaid },
    ],
    shares: [{ itemId: 'rioja', userIds: ['tom', 'priya'], ways: 3, units: 2, activity: [] }],
  } as never;

  it('shows the split, then the rest of the line, each with its own key and count', () => {
    const rows = claimRows(s, b, 'priya');
    expect(rows.map((r) => [r.key, r.kind, r.group, r.count, r.mine, r.left])).toEqual([
      ['rioja:split', 'share', 'yours', 2, 1, 1],
      ['rioja', 'multi', 'open', 2, 0, 1],
    ]);
  });

  it('drops the claim row once the split covers the whole line', () => {
    const whole = { ...(s as object), shares: [{ itemId: 'rioja', userIds: ['tom'], ways: 2, units: 4, activity: [] }] } as never;
    expect(claimRows(whole, b, 'tom').map((r) => r.key)).toEqual(['rioja:split']);
  });
});

describe('claimPortions', () => {
  const ids = (rows: ReturnType<typeof claimPortions>) => rows.map((r) => [r.key, r.state, r.holders.map((p) => p.userId).join()]);

  it('shows several of one thing as a row per portion, mine first, in bill order', () => {
    const rows = claimPortions(session, bill, 'tom');
    expect(ids(rows).slice(0, 6)).toEqual([
      ['bread#1', 'mine', ''],
      ['bread#2', 'theirs', 'priya'],
      ['bread#3', 'open', ''],
      ['bread#4', 'open', ''],
      ['calamari', 'theirs', 'priya'],
      ['lasagne', 'mine', ''],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'portion', n: 1, of: 4, left: 2 });
    expect(rows.find((r) => r.key === 'calamari')!.canSplit).toBe(true);
    expect(rows.find((r) => r.key === 'wine')).toMatchObject({ kind: 'share', state: 'open', left: 1 });
  });

  it('keeps my portion where I tapped it', () => {
    const rows = claimPortions(session, bill, 'tom', { bread: [4] });
    expect(ids(rows).slice(0, 4)).toEqual([
      ['bread#1', 'theirs', 'priya'],
      ['bread#2', 'open', ''],
      ['bread#3', 'open', ''],
      ['bread#4', 'mine', ''],
    ]);
  });

  it('ignores a tap that no longer fits, and never offers Split on a portion', () => {
    const rows = claimPortions(session, bill, 'tom', { bread: [9, 0], negroni: [1] });
    expect(rows[0]!.key).toBe('bread#1');
    expect(rows[0]!.state).toBe('mine');
    expect(rows.filter((r) => r.item.itemId === 'negroni').map((r) => [r.state, r.canSplit])).toEqual([
      ['theirs', false],
      ['theirs', false],
    ]);
  });

  it('numbers the rest of a longer line after its split', () => {
    const s = { participants: [{ userId: 'tom', claimedItemIds: [], sharedItemIds: ['bread'], payment: unpaid }], shares: [{ itemId: 'bread', userIds: ['tom'], ways: 2, units: 2, activity: [] }] } as never;
    const rows = claimPortions(s, bill, 'tom').filter((r) => r.item.itemId === 'bread');
    expect(rows.map((r) => [r.key, r.kind, r.state])).toEqual([
      ['bread:split', 'share', 'mine'],
      ['bread#3', 'portion', 'open'],
      ['bread#4', 'portion', 'open'],
    ]);
    expect(rows[0]!.units).toBe(2);
  });
});
