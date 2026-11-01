import { describe, expect, it } from 'vitest';
import { periodFor, renderEmail, summarise } from './costReport.js';

const day = (start: string, costs: Record<string, number>) => ({
  TimePeriod: { Start: start, End: start },
  Groups: Object.entries(costs).map(([service, usd]) => ({
    Keys: [service],
    Metrics: { UnblendedCost: { Amount: String(usd), Unit: 'USD' } },
  })),
});

describe('periodFor', () => {
  it('reports yesterday and its month so far', () => {
    expect(periodFor(new Date('2026-11-15T07:00:00Z'))).toEqual({
      yesterday: '2026-11-14',
      monthStart: '2026-11-01',
      today: '2026-11-15',
    });
  });

  it('on the 1st, reports the whole of last month', () => {
    expect(periodFor(new Date('2026-12-01T07:00:00Z'))).toEqual({
      yesterday: '2026-11-30',
      monthStart: '2026-11-01',
      today: '2026-12-01',
    });
  });
});

describe('summarise', () => {
  const results = [
    day('2026-11-13', { 'AWS Secrets Manager': 0.06, 'Amazon Bedrock': 0.5 }),
    day('2026-11-14', { 'AWS Secrets Manager': 0.06, 'Amazon Bedrock': 1.2, 'Amazon S3': 0.001 }),
  ];

  it('totals yesterday and the month by service, biggest first, leaving out crumbs', () => {
    const r = summarise(results, '2026-11-14', 9.5);
    expect(r.monthName).toBe('November');
    expect(r.yesterday).toEqual([
      { service: 'Amazon Bedrock', usd: 1.2 },
      { service: 'AWS Secrets Manager', usd: 0.06 },
    ]);
    expect(r.yesterdayTotal).toBeCloseTo(1.261);
    expect(r.month.map((s) => s.service)).toEqual(['Amazon Bedrock', 'AWS Secrets Manager']);
    expect(r.monthTotal).toBeCloseTo(1.821);
    expect(r.forecast).toBe(9.5);
  });

  it('copes with no results', () => {
    expect(summarise([], '2026-11-14', null)).toMatchObject({
      yesterday: [],
      yesterdayTotal: 0,
      month: [],
      monthTotal: 0,
    });
  });
});

describe('renderEmail', () => {
  it('puts the numbers in the subject and lists services', () => {
    const e = renderEmail(
      summarise([day('2026-11-14', { 'Amazon Bedrock': 1.2, '<b>x</b>': 0.5 })], '2026-11-14', 30),
    );
    expect(e.subject).toBe('AWS $1.70 yesterday · $1.70 in November · forecast $30.00');
    expect(e.text).toContain('   $1.20  Amazon Bedrock');
    expect(e.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(e.html).not.toContain('<b>x</b>');
  });

  it('leaves the forecast out when there is none', () => {
    const e = renderEmail(summarise([], '2026-11-30', null));
    expect(e.subject).toBe('AWS $0.00 yesterday · $0.00 in November');
    expect(e.text).toContain('(nothing over $0.01)');
  });
});
