import { describe, it, expect } from 'vitest';
import { buildReport, renderReportEmail } from './report.js';
import type { Bill } from '../../types/bills.js';
import type { Session, Participant } from '../../types/sessions.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PIZZA = ID(1);
const WINE = ID(2);
const BREAD = ID(3);
const PAY_B = ID(10);
const PAY_C = ID(11);

const bill: Bill = {
  billId: ID(100),
  versionNumber: 1,
  creatorUserId: 'lead',
  currency: 'GBP',
  items: [
    { itemId: PIZZA, name: 'Pizza', unitPricePence: 1200, quantity: 1, category: 'food' },
    { itemId: WINE, name: 'Wine', unitPricePence: 600, quantity: 3, category: 'drink' },
    { itemId: BREAD, name: 'Bread <warm>', unitPricePence: 400, quantity: 1, category: 'food' },
  ],
  subtotalPence: 3400,
  taxPence: 0,
  serviceChargePence: 340,
  totalPence: 3740,
  parsedFrom: {
    imageHash: 'a'.repeat(64),
    parser: 'fixture',
    parserVersion: '1',
    parsedAt: '2026-10-31T19:00:00.000Z',
  },
  venue: { name: 'Gennaro' },
} as Bill;

const person = (userId: string, rest: Partial<Participant> = {}): Participant => ({
  userId,
  displayName: userId === 'lead' ? 'Callum' : userId === 'b' ? 'Bea' : 'Dev',
  claimedItemIds: [],
  sharedItemIds: [],
  payment: { status: 'unpaid' },
  readyToLock: true,
  ...rest,
});

const session = (status: Session['status']): Session => ({
  sessionId: ID(200),
  status,
  creatorUserId: 'lead',
  collectorUserId: 'lead',
  billId: bill.billId,
  pinnedBillVersion: 1,
  venue: { name: 'Gennaro' },
  createdAt: '2026-10-31T19:30:00.000Z',
  shareSettings: [{ itemId: PIZZA, ways: 3, version: 1, activity: [] }],
  participants: [
    person('lead', {
      claimedItemIds: [WINE],
      sharedItemIds: [PIZZA],
      payment: { status: 'self_paid' },
    }),
    person('b', {
      claimedItemIds: [WINE, WINE],
      sharedItemIds: [PIZZA],
      payment: { status: 'succeeded', paymentId: PAY_B, paidAt: '2026-10-31T21:00:00.000Z' },
    }),
    person('c', {
      payment: {
        status: 'pending',
        paymentId: PAY_C,
        payerClaimedPaidAt: '2026-10-31T21:05:00.000Z',
      },
    }),
  ],
});

const amounts = new Map([
  [PAY_B, 1980],
  [PAY_C, 500],
]);

describe('buildReport', () => {
  it('splits shares by ways and leaves open spots and untaken items unclaimed while open', () => {
    const r = buildReport(session('claiming'), bill, amounts);
    const b = r.diners.find((d) => d.userId === 'b')!;
    expect(b.lines).toEqual([
      { name: 'Pizza', detail: 'split 3 ways', pence: 400 },
      { name: 'Wine', detail: '× 2', pence: 1200 },
    ]);
    expect(r.unclaimed).toEqual([
      { name: 'Pizza', detail: '1 of 3 shares', pence: 400 },
      { name: 'Bread <warm>', pence: 400 },
    ]);
  });

  it('adds every penny of service back up to the bill, unclaimed included', () => {
    const r = buildReport(session('claiming'), bill, amounts);
    const total = r.diners.reduce((a, d) => a + d.totalPence, 0) + r.unclaimedPence;
    expect(total).toBe(bill.totalPence);
  });

  it('gives the lead whatever is left once the bill is closed', () => {
    const r = buildReport(session('settled'), bill, amounts);
    expect(r.unclaimed).toEqual([]);
    const lead = r.diners[0]!;
    expect(lead.isLead).toBe(true);
    expect(lead.lines.filter((l) => l.detail === 'not claimed').map((l) => l.name)).toEqual([
      'Pizza',
      'Bread <warm>',
    ]);
    expect(r.diners.reduce((a, d) => a + d.totalPence, 0)).toBe(bill.totalPence);
  });

  it('reports paid, says-paid and the lead', () => {
    const r = buildReport(session('claiming'), bill, amounts);
    const paid = Object.fromEntries(r.diners.map((d) => [d.userId, d.paid]));
    expect(paid).toEqual({
      lead: { kind: 'lead' },
      b: { kind: 'paid', amountPence: 1980 },
      c: { kind: 'says_paid', amountPence: 500 },
    });
    expect(r.collectedPence).toBe(1980);
  });
});

describe('renderReportEmail', () => {
  it('gives a guest only their own items', () => {
    const r = buildReport(session('settled'), bill, amounts);
    const email = renderReportEmail(r, 'b');
    expect(email.subject).toMatch(/^Your bill · Gennaro, /);
    expect(email.text).toContain('You had');
    expect(email.text).toContain('You paid £19.80');
    expect(email.text).not.toContain('Callum');
    expect(email.text).not.toContain('Dev');
  });

  it('gives the lead everyone, themselves first', () => {
    const r = buildReport(session('claiming'), bill, amounts);
    const email = renderReportEmail(r, 'lead');
    expect(email.subject).toMatch(/^Who paid what · Gennaro, /);
    const order = ['Callum (you)', 'Bea', 'Dev'].map((n) => email.text.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(email.text).toContain('Says paid £5.00');
    expect(email.text).toContain('Not claimed yet');
  });

  it('escapes item names in the HTML', () => {
    const r = buildReport(session('settled'), bill, amounts);
    const { html } = renderReportEmail(r, 'lead');
    expect(html).toContain('Bread &lt;warm&gt;');
    expect(html).not.toContain('<warm>');
  });
});
