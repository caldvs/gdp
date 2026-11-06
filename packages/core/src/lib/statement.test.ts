import { describe, expect, it } from 'vitest';
import { billStatement, statementText, statusText, whenText } from './statement';

// Items £60.00, service 10%: £66.00.
const bill = {
  billId: 'b1',
  items: [
    { itemId: 'bread', name: 'Garlic bread', unitPricePence: 500, quantity: 4, category: 'food' },
    { itemId: 'calamari', name: 'Calamari', unitPricePence: 2000, quantity: 1, category: 'food' },
    { itemId: 'wine', name: 'Wine', unitPricePence: 1500, quantity: 1, category: 'drink' },
    { itemId: 'cake', name: 'Cake', unitPricePence: 300, quantity: 1, category: 'food' },
    { itemId: 'port', name: 'Port', unitPricePence: 900, quantity: 1, category: 'drink' },
  ],
  subtotalPence: 6700,
  serviceChargePence: 670,
  taxPence: 0,
  totalPence: 7370,
} as never;

const session = {
  creatorUserId: 'lead',
  participants: [
    { userId: 'sam', displayName: 'Sam', claimedItemIds: ['bread'], sharedItemIds: ['calamari'], payment: { status: 'succeeded', paymentId: 'p1', paidAt: '2026-10-31T21:30:00.000Z' }, payments: [{ paymentId: 'p1', amountPence: 1650, status: 'succeeded', paidAt: '2026-10-31T21:30:00.000Z' }] },
    { userId: 'lead', displayName: 'Callum', claimedItemIds: ['bread', 'bread'], sharedItemIds: [], payment: { status: 'self_paid' } },
    { userId: 'priya', displayName: 'Priya', claimedItemIds: [], sharedItemIds: ['calamari', 'wine'], payment: { status: 'pending', paymentId: 'p2', payerClaimedPaidAt: '2026-10-31T21:14:00.000Z' }, payments: [{ paymentId: 'p2', amountPence: 1925, status: 'pending', payerClaimedPaidAt: '2026-10-31T21:14:00.000Z' }] },
    { userId: 'tom', displayName: 'Tom', claimedItemIds: ['cake'], sharedItemIds: [], payment: { status: 'unpaid' } },
  ],
  shares: [
    { itemId: 'calamari', userIds: ['sam', 'priya'], ways: 2, activity: [] },
    { itemId: 'wine', userIds: ['priya'], ways: 3, activity: [] },
  ],
} as never;

describe('billStatement', () => {
  const st = billStatement(session, bill, (p) => p.displayName);

  it('lists the lead first, then each guest with their items, service and status', () => {
    expect(st.people.map((p) => [p.name, p.status, p.totalPence])).toEqual([
      ['Callum', 'lead', 1100],
      ['Sam', 'paid', 1650],
      ['Priya', 'says-paid', 1650],
      ['Tom', 'not-paid', 330],
    ]);
    expect(st.people[1]!.items).toEqual([
      { label: 'Garlic bread (1 of 4)', pence: 500 },
      { label: 'Calamari (half)', pence: 1000 },
    ]);
    expect(st.people[1]!.extrasPence).toBe(150);
    expect(st.people[2]!.items[1]).toEqual({ label: 'Wine (1 of 3 ways)', pence: 500 });
  });

  it('puts what nobody claimed on the lead, so everything adds up to the bill', () => {
    expect(st.unclaimed.items).toEqual([
      { label: 'Garlic bread (1 of 4)', pence: 500 },
      { label: 'Wine (2 of 3 ways)', pence: 1000 },
      { label: 'Port', pence: 900 },
    ]);
    const all = st.people.reduce((a, p) => a + p.totalPence, 0) + st.unclaimed.totalPence;
    expect(all).toBe(7370);
    expect(st.owedByGuestsPence).toBe(7370 - 1100 - st.unclaimed.totalPence);
  });

  it('lists payments with times; received counts only what the lead confirmed', () => {
    expect(st.payments).toEqual([
      { name: 'Sam', at: '2026-10-31T21:30:00.000Z', confirmed: true, amountPence: 1650 },
      { name: 'Priya', at: '2026-10-31T21:14:00.000Z', confirmed: false, amountPence: 1925 },
    ]);
    expect(st.unpaid).toEqual([{ name: 'Tom', pence: 330 }]);
    expect(st.receivedPence).toBe(1650);
    expect(st.outstandingPence).toBe(1650 + 330);
  });

  it('has no unclaimed section when everything is claimed', () => {
    const s = { creatorUserId: 'lead', participants: [{ userId: 'lead', displayName: 'C', claimedItemIds: ['cake'], sharedItemIds: [], payment: { status: 'self_paid' } }], shares: [] } as never;
    const b = { items: [(bill as { items: unknown[] }).items[3]], subtotalPence: 300, serviceChargePence: 0, taxPence: 0, totalPence: 300 } as never;
    const one = billStatement(s, b, () => 'Callum');
    expect(one.unclaimed).toEqual({ items: [], extrasPence: 0, discountPence: 0, totalPence: 0 });
    expect(one.owedByGuestsPence).toBe(0);
  });

  it('shows a shared discount on the bill and each person, and still adds up (8 Nov 2026)', () => {
    const s = {
      creatorUserId: 'lead',
      platformFeePence: 0,
      participants: [
        { userId: 'lead', displayName: 'C', claimedItemIds: ['a'], sharedItemIds: [], payment: { status: 'self_paid' } },
        { userId: 'g', displayName: 'S', claimedItemIds: ['b'], sharedItemIds: [], payment: { status: 'not_started' } },
      ],
      shares: [],
    } as never;
    const b = {
      items: [
        { itemId: 'a', name: 'Roast Beef', unitPricePence: 2600, quantity: 1, category: 'food' },
        { itemId: 'b', name: 'Roast Beef', unitPricePence: 2600, quantity: 1, category: 'food' },
      ],
      subtotalPence: 5200,
      serviceChargePence: 650,
      taxPence: 0,
      discounts: [{ name: 'Loyalty', amountPence: 5000 }],
      totalPence: 850,
    } as never;
    const st = billStatement(s, b, (p) => p.displayName);
    expect(st.discountPence).toBe(5000);
    for (const p of st.people) {
      expect(p.discountPence).toBe(2500);
      const items = p.items.reduce((acc, i) => acc + i.pence, 0);
      expect(items + p.extrasPence - p.discountPence + p.feePence).toBe(p.totalPence);
    }
    expect(st.people.reduce((acc, p) => acc + p.totalPence, 0)).toBe(850);
  });
});

describe('billStatement: a split covering several of a line', () => {
  it('names how many it covers and leaves the rest of the line unclaimed', () => {
    const b = {
      billId: 'b2',
      items: [{ itemId: 'rioja', name: 'Rioja', unitPricePence: 2400, quantity: 3, category: 'drink' }],
      subtotalPence: 7200,
      serviceChargePence: 0,
      taxPence: 0,
      totalPence: 7200,
    } as never;
    const s = {
      creatorUserId: 'lead',
      participants: [
        { userId: 'lead', displayName: 'Callum', claimedItemIds: [], sharedItemIds: ['rioja'], payment: { status: 'self_paid' } },
        { userId: 'sam', displayName: 'Sam', claimedItemIds: [], sharedItemIds: ['rioja'], payment: { status: 'unpaid' } },
      ],
      shares: [{ itemId: 'rioja', userIds: ['lead', 'sam'], ways: 3, units: 2, activity: [] }],
    } as never;
    const st = billStatement(s, b, (p) => p.displayName);
    expect(st.people[1]!.items).toEqual([{ label: '2 × Rioja (1 of 3 ways)', pence: 1600 }]);
    expect(st.unclaimed.items).toEqual([
      { label: '2 × Rioja (1 of 3 ways)', pence: 1600 },
      { label: 'Rioja (1 of 3)', pence: 2400 },
    ]);
  });
});

describe('statementText', () => {
  it('reads like the emailed report', () => {
    const st = billStatement(session, bill, (p) => p.displayName);
    const text = statementText(st, { title: 'Bill summary: Gennaro', leadName: 'Callum', feePence: 200 });
    expect(text).toContain('Bill summary: Gennaro');
    expect(text).toContain('Platform fee £2.00, paid by Callum.');
    expect(text).toContain('Sam · Paid');
    expect(text).toMatch(/Calamari \(half\) +£10\.00/);
    expect(text).toContain('Nobody claimed · goes to Callum');
    expect(text).toMatch(/Tom, not paid +£3\.30/);
    expect(text).toMatch(/Own share +-£11\.00|Own share +−£11\.00/);
    expect(text).toContain('Paid the platform fee');
  });

  it('leaves out the fee and service when there are none', () => {
    const s = { creatorUserId: 'lead', participants: [{ userId: 'lead', displayName: 'C', claimedItemIds: ['cake'], sharedItemIds: [], payment: { status: 'self_paid' } }], shares: [] } as never;
    const b = { items: [(bill as { items: unknown[] }).items[3]], subtotalPence: 300, serviceChargePence: 0, taxPence: 0, totalPence: 300 } as never;
    const text = statementText(billStatement(s, b, () => 'Callum'), { title: 'T', leadName: 'Callum' });
    expect(text).not.toContain('Platform fee');
    expect(text).not.toContain('Service');
  });
});

describe('helpers', () => {
  it('statusText and whenText', () => {
    expect(statusText('part-paid')).toBe('Part paid');
    expect(whenText('2026-10-31T21:14:00.000Z')).toBe('Sat 21:14');
    expect(whenText('nope')).toBe('');
  });
});
