import { describe, expect, it } from 'vitest';
import { leadSubject, renderLeadEmail } from './leadEmail.js';
import type { BillReport, DinerReport } from './report.js';

const diner = (over: Partial<DinerReport>): DinerReport => ({
  userId: 'u',
  displayName: 'Someone',
  isLead: false,
  lines: [],
  itemsPence: 0,
  extrasPence: 0,
  feePence: 0,
  totalPence: 0,
  paid: { kind: 'not_paid' },
  ...over,
});

const report = (guests: DinerReport[], over: Partial<BillReport> = {}): BillReport => ({
  venueName: 'Gennaro',
  dateISO: '2026-11-07T19:30:00Z',
  settled: true,
  leadName: 'Callum',
  billTotalPence: 9600,
  diners: [
    diner({
      userId: 'lead',
      displayName: 'Callum',
      isLead: true,
      totalPence: 3200,
      paid: { kind: 'lead' },
    }),
    ...guests,
  ],
  unclaimed: [],
  unclaimedPence: 0,
  collectedPence: 0,
  toCollectPence: 0,
  ...over,
});

const paid = (name: string, p: number) =>
  diner({ userId: name, displayName: name, totalPence: p, paid: { kind: 'paid', amountPence: p } });
const owing = (name: string, p: number) =>
  diner({ userId: name, displayName: name, totalPence: p });

describe('#221 lead email', () => {
  it('subject says how it ended', () => {
    expect(leadSubject(report([paid('Sam', 2000)]))).toBe('Everyone’s paid for Gennaro');
    expect(leadSubject(report([paid('Sam', 2000), owing('Tom Hill', 2531)]))).toBe(
      'Tom still owes you £25.31 for Gennaro',
    );
    expect(leadSubject(report([owing('Tom', 2531), owing('Ana', 1000)]))).toBe(
      '2 people still owe you £35.31 for Gennaro',
    );
    expect(
      leadSubject(
        report([diner({ displayName: 'Ana', paid: { kind: 'says_paid', amountPence: 900 } })]),
      ),
    ).toBe('Check Ana’s payment for Gennaro');
    expect(leadSubject(report([], { venueName: undefined }))).toBe('Everyone’s paid for your bill');
  });

  it('body: the lead’s share, each guest, Nobody claimed, Open the bill; html escaped; plain text too', () => {
    const r = report([paid('Sam', 2000), owing('<Tom>', 2531)], {
      unclaimed: [{ name: 'Tiramisu', pence: 650 }],
      unclaimedPence: 731,
      collectedPence: 2000,
    });
    const e = renderLeadEmail(r, 'https://paymeback.dev/session/s1');
    expect(e.text).toContain('Your share  £32.00');
    expect(e.text).toContain('Sam  Paid £20.00');
    expect(e.text).toContain('<Tom>  Owes £25.31');
    expect(e.text).toContain('Nobody claimed (not paid back)');
    expect(e.text).toContain('  Tiramisu  £6.50');
    expect(e.text).toContain('Open the bill: https://paymeback.dev/session/s1');
    expect(e.html).toContain('&lt;Tom&gt;');
    expect(e.html).not.toContain('<Tom>');
    expect(e.html).toContain('Nobody claimed');
    expect(e.html).toContain('href="https://paymeback.dev/session/s1"');
    // Mail-client safe: tables, no web fonts, masks or stylesheets.
    expect(e.html).not.toMatch(/@font-face|mask|<style|<link/);
    expect(e.html).toContain('role="presentation"');
  });

  it('nobody joined', () => {
    const e = renderLeadEmail(report([]), 'https://x/session/s');
    expect(e.text).toContain('Nobody joined.');
    expect(e.html).toContain('Nobody joined.');
  });
});
