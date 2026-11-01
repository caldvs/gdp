import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type ResultByTime,
} from '@aws-sdk/client-cost-explorer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * Daily AWS cost email (infra/costReport.ts runs it every morning).
 *
 * Two Cost Explorer calls a day (each costs $0.01): this month's costs by
 * day and service, and the forecast to the month's end. The account is
 * shared by dev and prod, so this is the whole account's spend. Amounts are
 * in USD, as AWS bills them. Cost Explorer lags by up to a day, so
 * "yesterday" can still grow a little.
 */

export type ServiceCost = { service: string; usd: number };
export type CostReport = {
  day: string;
  /** "November", for the month so far (yesterday's month). */
  monthName: string;
  yesterday: ServiceCost[];
  yesterdayTotal: number;
  month: ServiceCost[];
  monthTotal: number;
  forecast: number | null;
};

/** Below this a service isn't worth a line. */
const NOISE = 0.005;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The days to ask about, for a report sent on `now`: yesterday, and its month so far. */
export function periodFor(now: Date): { yesterday: string; monthStart: string; today: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  const monthStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
  return { yesterday: iso(yesterday), monthStart: iso(monthStart), today: iso(today) };
}

const byCost = (a: ServiceCost, b: ServiceCost) => b.usd - a.usd;
const sum = (xs: ServiceCost[]) => xs.reduce((t, x) => t + x.usd, 0);

/** Adds up Cost Explorer's daily, per-service results into the report. */
export function summarise(
  results: ResultByTime[],
  yesterday: string,
  forecast: number | null,
): CostReport {
  const month = new Map<string, number>();
  const day = new Map<string, number>();
  for (const r of results) {
    for (const g of r.Groups ?? []) {
      const service = g.Keys?.[0] ?? 'Other';
      const amount = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      month.set(service, (month.get(service) ?? 0) + amount);
      if (r.TimePeriod?.Start === yesterday) day.set(service, (day.get(service) ?? 0) + amount);
    }
  }
  const list = (m: Map<string, number>) =>
    [...m]
      .map(([service, n]) => ({ service, usd: n }))
      .filter((s) => s.usd >= NOISE)
      .sort(byCost);
  const yesterdayList = list(day);
  const monthList = list(month);
  return {
    day: yesterday,
    monthName: new Date(`${yesterday}T00:00:00Z`).toLocaleString('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    }),
    yesterday: yesterdayList,
    yesterdayTotal: sum([...day].map(([service, n]) => ({ service, usd: n }))),
    month: monthList,
    monthTotal: sum([...month].map(([service, n]) => ({ service, usd: n }))),
    forecast,
  };
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEmail(r: CostReport): { subject: string; text: string; html: string } {
  const forecast = r.forecast === null ? '' : ` · forecast ${usd(r.forecast)}`;
  const subject = `AWS ${usd(r.yesterdayTotal)} yesterday · ${usd(r.monthTotal)} in ${r.monthName}${forecast}`;
  const lines = (xs: ServiceCost[]) =>
    xs.length === 0
      ? ['  (nothing over $0.01)']
      : xs.map((s) => `  ${usd(s.usd).padStart(8)}  ${s.service}`);
  const text = [
    `Yesterday (${r.day}): ${usd(r.yesterdayTotal)}`,
    ...lines(r.yesterday),
    '',
    `${r.monthName} so far: ${usd(r.monthTotal)}${r.forecast === null ? '' : `, forecast ${usd(r.forecast)}`}`,
    ...lines(r.month),
    '',
    'Whole AWS account (dev and prod), in USD. Cost Explorer can lag by a day.',
  ].join('\n');

  const rows = (xs: ServiceCost[]) =>
    xs.length === 0
      ? '<tr><td colspan="2" style="padding:4px 0;color:#59636e">Nothing over $0.01</td></tr>'
      : xs
          .map(
            (s) =>
              `<tr><td style="padding:4px 16px 4px 0">${escape(s.service)}</td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${usd(s.usd)}</td></tr>`,
          )
          .join('');
  const section = (title: string, total: string, xs: ServiceCost[]) =>
    `<h2 style="font-size:16px;margin:20px 0 6px">${title} <span style="font-weight:400;color:#59636e">${total}</span></h2>` +
    `<table style="border-collapse:collapse;font-size:14px">${rows(xs)}</table>`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2328;max-width:520px">` +
    section(`Yesterday`, `${r.day} · ${usd(r.yesterdayTotal)}`, r.yesterday) +
    section(
      `${r.monthName} so far`,
      `${usd(r.monthTotal)}${r.forecast === null ? '' : ` · forecast ${usd(r.forecast)}`}`,
      r.month,
    ) +
    `<p style="font-size:12px;color:#59636e;margin-top:20px">Whole AWS account (dev and prod), in USD. Cost Explorer can lag by a day.</p></div>`;
  return { subject, text, html };
}

export async function handler(): Promise<{ sent: string }> {
  const to = process.env.COST_REPORT_TO;
  const from = process.env.COST_REPORT_FROM;
  if (!to || !from) throw new Error('COST_REPORT_TO and COST_REPORT_FROM must be set');

  // Cost Explorer only answers in us-east-1.
  const ce = new CostExplorerClient({ region: 'us-east-1' });
  const p = periodFor(new Date());
  const usage = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: p.monthStart, End: p.today },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );

  // Forecast for the rest of the month: none on the 1st (yesterday's month
  // is over) or when Cost Explorer can't make one.
  const now = new Date(`${p.today}T00:00:00Z`);
  const nextMonth = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  const sameMonth = p.monthStart.slice(0, 7) === p.today.slice(0, 7);
  let forecastRest: number | null = null;
  if (sameMonth)
    try {
      const f = await ce.send(
        new GetCostForecastCommand({
          TimePeriod: { Start: p.today, End: nextMonth },
          Granularity: 'MONTHLY',
          Metric: 'UNBLENDED_COST',
        }),
      );
      forecastRest = Number(f.Total?.Amount ?? 0);
    } catch {
      // Too little history, or the last day of the month: no forecast.
    }

  const partial = summarise(usage.ResultsByTime ?? [], p.yesterday, null);
  const report: CostReport = {
    ...partial,
    forecast: forecastRest === null ? null : partial.monthTotal + forecastRest,
  };
  const email = renderEmail(report);

  await new SESv2Client({}).send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: email.subject },
          Body: { Text: { Data: email.text }, Html: { Data: email.html } },
        },
      },
    }),
  );
  return { sent: email.subject };
}
