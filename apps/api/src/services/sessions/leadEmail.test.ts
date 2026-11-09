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
  discountPence: 0,
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
  it('says the summary is ready, with no amounts or names', () => {
    const r = report([paid('Sam', 2000), owing('<Tom>', 2531)], {
      unclaimed: [{ name: 'Tiramisu', pence: 650 }],
      unclaimedPence: 731,
      collectedPence: 2000,
    });
    expect(leadSubject(r)).toBe('Your bill summary for Gennaro is ready');
    const e = renderLeadEmail(r, 'https://paymeback.dev/session/s1');
    expect(e.subject).toBe('Your bill summary for Gennaro is ready');
    expect(e.text).toContain('See who paid what in the app.');
    expect(e.text).toContain('Open the bill: https://paymeback.dev/session/s1');
    expect(e.html).toContain('href="https://paymeback.dev/session/s1"');
    for (const part of [e.subject, e.text, e.html]) {
      expect(part).not.toMatch(/£|Tom|Sam|Tiramisu/);
    }
    // Mail-client safe: tables, no web fonts, masks or stylesheets.
    expect(e.html).not.toMatch(/@font-face|mask|<style|<link/);
    expect(e.html).toContain('role="presentation"');
  });

  it('no venue on the bill; venue names are escaped', () => {
    expect(leadSubject(report([], { venueName: undefined }))).toBe('Your bill summary is ready');
    const e = renderLeadEmail(report([], { venueName: '<b>Bar</b>' }), 'https://x/session/s');
    expect(e.html).toContain('&lt;b&gt;Bar&lt;/b&gt;');
    expect(e.html).not.toContain('<b>Bar</b>');
  });
});
