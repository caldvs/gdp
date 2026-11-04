import { apportionByWeight, splitShare } from './allocation.js';
import { feeSharePence } from '../payments/ledger.js';
import type { Bill } from '../../types/bills.js';
import type { Session, Participant } from '../../types/sessions.js';

/**
 * A bill report: who had what and who has paid. The lead's covers every
 * diner (themselves included); a guest's covers only them. Emailed when the
 * lead closes the bill, and on request any time before that.
 *
 * Money follows the server's allocation: whole-unit claims, splits by
 * `splitShare`, then service and tax apportioned over each diner's items.
 * Anything not yet taken is carried as its own "unclaimed" share so the
 * extras still add up to the bill; on a settled bill it is the lead's.
 */

const UNCLAIMED = '￿#unclaimed';

export type ReportLine = { name: string; detail?: string; pence: number };

export type PaidState =
  | { kind: 'lead' }
  | { kind: 'paid'; amountPence: number }
  | { kind: 'says_paid'; amountPence: number }
  | { kind: 'not_paid' };

export type DinerReport = {
  userId: string;
  displayName: string;
  isLead: boolean;
  lines: ReportLine[];
  itemsPence: number;
  extrasPence: number;
  /** Their part of the lead's platform fee hold (#166); 0 for the lead. */
  feePence: number;
  totalPence: number;
  paid: PaidState;
};

export type BillReport = {
  venueName?: string;
  dateISO: string;
  settled: boolean;
  leadName: string;
  billTotalPence: number;
  diners: DinerReport[];
  /** Items nobody has taken yet. Empty on a settled bill (they're the lead's). */
  unclaimed: ReportLine[];
  unclaimedPence: number;
  /** Guests' payments the lead has confirmed. */
  collectedPence: number;
  /** Guests' shares not yet confirmed as paid. */
  toCollectPence: number;
};

/** Amount the payer sent, by paymentId, for payments the report needs. */
export type PaymentAmounts = ReadonlyMap<string, number>;

export function buildReport(session: Session, bill: Bill, amounts: PaymentAmounts): BillReport {
  const settled = session.status === 'settled';
  const splitByItem = new Map((session.shareSettings ?? []).map((s) => [s.itemId, s]));
  const linesByUser = new Map<string, ReportLine[]>(
    session.participants.map((p) => [p.userId, []]),
  );
  const unclaimed: ReportLine[] = [];

  for (const item of bill.items) {
    const sharers = session.participants
      .filter((p) => (p.sharedItemIds ?? []).includes(item.itemId))
      .map((p) => p.userId);

    let shared = 0;
    if (sharers.length > 0) {
      const st = splitByItem.get(item.itemId);
      const ways = Math.max(st?.ways ?? sharers.length, sharers.length);
      shared = st?.units ?? 1;
      const price = item.unitPricePence * shared;
      const name = shared > 1 ? `${item.name} × ${shared}` : item.name;
      const parts = splitShare(price, sharers, ways);
      for (const [userId, pence] of parts) {
        linesByUser.get(userId)?.push({ name, detail: `split ${ways} ways`, pence });
      }
      const taken = [...parts.values()].reduce((a, b) => a + b, 0);
      const open = ways - sharers.length;
      if (open > 0) {
        unclaimed.push({ name, detail: `${open} of ${ways} shares`, pence: price - taken });
      }
    }

    let claimedUnits = 0;
    for (const p of session.participants) {
      const n = p.claimedItemIds.filter((id) => id === item.itemId).length;
      if (n === 0) continue;
      claimedUnits += n;
      linesByUser.get(p.userId)?.push(unitLine(item.name, n, item.unitPricePence));
    }
    const left = item.quantity - shared - claimedUnits;
    if (left > 0) unclaimed.push(unitLine(item.name, left, item.unitPricePence));
  }

  const lead = session.participants.find((p) => p.userId === session.creatorUserId);
  if (settled && lead && unclaimed.length > 0) {
    linesByUser.get(lead.userId)?.push(...unclaimed.map((l) => ({ ...l, detail: 'not claimed' })));
    unclaimed.length = 0;
  }

  const itemsByUser = new Map<string, number>();
  for (const [userId, lines] of linesByUser) itemsByUser.set(userId, sum(lines));
  const unclaimedPence = sum(unclaimed);
  const weights = new Map(itemsByUser);
  if (unclaimedPence > 0) weights.set(UNCLAIMED, unclaimedPence);
  const extras = apportionByWeight(bill.serviceChargePence + bill.taxPence, weights);

  const diners: DinerReport[] = session.participants.map((p) => {
    const itemsPence = itemsByUser.get(p.userId) ?? 0;
    const extrasPence = extras.get(p.userId) ?? 0;
    const feePence =
      p.userId === session.creatorUserId
        ? 0
        : feeSharePence(session.platformFeePence ?? 0, itemsPence, bill.subtotalPence);
    return {
      userId: p.userId,
      displayName: p.displayName,
      isLead: p.userId === session.creatorUserId,
      lines: linesByUser.get(p.userId) ?? [],
      itemsPence,
      extrasPence,
      feePence,
      totalPence: itemsPence + extrasPence + feePence,
      paid: paidState(p, session.creatorUserId, amounts),
    };
  });
  // The lead first, then everyone else in the order they joined.
  diners.sort((a, b) => Number(b.isLead) - Number(a.isLead));

  const guests = diners.filter((d) => !d.isLead);
  const collectedPence = guests.reduce(
    (a, d) => a + (d.paid.kind === 'paid' ? d.paid.amountPence : 0),
    0,
  );
  const toCollectPence = guests.reduce(
    (a, d) => a + (d.paid.kind === 'paid' ? 0 : d.totalPence),
    0,
  );

  return {
    ...(session.venue?.name ? { venueName: session.venue.name } : {}),
    dateISO: session.createdAt,
    settled,
    leadName: lead?.displayName ?? 'the lead',
    billTotalPence: bill.totalPence,
    diners,
    unclaimed,
    unclaimedPence: unclaimedPence + (extras.get(UNCLAIMED) ?? 0),
    collectedPence,
    toCollectPence,
  };
}

function unitLine(name: string, units: number, unitPricePence: number): ReportLine {
  return units > 1
    ? { name, detail: `× ${units}`, pence: unitPricePence * units }
    : { name, pence: unitPricePence };
}

function paidState(p: Participant, leadId: string, amounts: PaymentAmounts): PaidState {
  if (p.userId === leadId || p.payment.status === 'self_paid') return { kind: 'lead' };
  if (p.payment.status === 'succeeded') {
    return { kind: 'paid', amountPence: amounts.get(p.payment.paymentId) ?? 0 };
  }
  if (p.payment.status === 'pending' && p.payment.payerClaimedPaidAt) {
    return { kind: 'says_paid', amountPence: amounts.get(p.payment.paymentId) ?? 0 };
  }
  return { kind: 'not_paid' };
}

const sum = (lines: readonly ReportLine[]): number => lines.reduce((a, l) => a + l.pence, 0);

// ---------------------------------------------------------------- email

export type ReportEmail = { subject: string; text: string; html: string };

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

const when = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function paidText(d: DinerReport, leadName: string, forLead: boolean): string {
  switch (d.paid.kind) {
    case 'lead':
      return forLead ? 'Your share' : `${leadName}'s share`;
    case 'paid':
      return forLead
        ? `Paid ${money(d.paid.amountPence)}`
        : `You paid ${money(d.paid.amountPence)}`;
    case 'says_paid':
      return forLead
        ? `Says paid ${money(d.paid.amountPence)}`
        : `You sent ${money(d.paid.amountPence)}`;
    case 'not_paid':
      return forLead ? 'Not paid yet' : `Not paid yet · ${money(d.totalPence)} to ${leadName}`;
  }
}

/** The email for one recipient: the lead sees everyone, a guest only themselves. */
export function renderReportEmail(report: BillReport, recipientUserId: string): ReportEmail {
  const me = report.diners.find((d) => d.userId === recipientUserId);
  if (!me) throw new Error('Recipient is not on this bill');
  const forLead = me.isLead;
  const where = report.venueName ?? 'your meal';
  const date = when(report.dateISO);
  const state = report.settled ? 'Closed' : 'Still open';

  const subject = forLead ? `Who paid what · ${where}, ${date}` : `Your bill · ${where}, ${date}`;
  const shown = forLead ? report.diners : [me];

  // Plain text
  const t: string[] = [`${where} · ${date} · ${state}`, ''];
  for (const d of shown) {
    t.push(forLead ? (d.isLead ? `${d.displayName} (you)` : d.displayName) : 'You had');
    for (const l of d.lines)
      t.push(`  ${l.name}${l.detail ? ` (${l.detail})` : ''}  ${money(l.pence)}`);
    if (d.lines.length === 0) t.push('  Nothing yet');
    t.push(`  Service and tax  ${money(d.extrasPence)}`);
    if (d.feePence > 0) t.push(`  Platform fee  ${money(d.feePence)}`);
    t.push(`  Total  ${money(d.totalPence)} · ${paidText(d, report.leadName, forLead)}`, '');
  }
  if (forLead && report.unclaimed.length > 0) {
    t.push('Not claimed yet');
    for (const l of report.unclaimed)
      t.push(`  ${l.name}${l.detail ? ` (${l.detail})` : ''}  ${money(l.pence)}`);
    t.push('');
  }
  if (forLead) {
    t.push(
      `Bill ${money(report.billTotalPence)} · Collected ${money(report.collectedPence)} · To collect ${money(report.toCollectPence)}`,
    );
  }

  // HTML: plain tables, inline styles, so it survives every mail client.
  const font =
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const row = (left: string, right: string, style = '') =>
    `<tr><td style="padding:6px 0;${style}">${left}</td><td style="padding:6px 0;text-align:right;white-space:nowrap;${style}">${right}</td></tr>`;
  const lineRow = (l: ReportLine) =>
    row(
      `${esc(l.name)}${l.detail ? ` <span style="color:#6a6a6a">${esc(l.detail)}</span>` : ''}`,
      money(l.pence),
    );
  const block = (d: DinerReport) => {
    const title = forLead ? `${esc(d.displayName)}${d.isLead ? ' (you)' : ''}` : 'You had';
    const lines = d.lines.length
      ? d.lines.map(lineRow).join('')
      : row('<span style="color:#6a6a6a">Nothing yet</span>', '');
    return (
      `<h2 style="margin:24px 0 4px;font-size:17px">${title}</h2>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px">` +
      lines +
      row('<span style="color:#6a6a6a">Service and tax</span>', money(d.extrasPence)) +
      (d.feePence > 0
        ? row('<span style="color:#6a6a6a">Platform fee</span>', money(d.feePence))
        : '') +
      row(
        `<b>${money(d.totalPence)}</b>`,
        `<span style="color:${d.paid.kind === 'not_paid' ? '#9a6700' : '#1a7f37'}">${esc(paidText(d, report.leadName, forLead))}</span>`,
        'border-top:1px solid #d0d7de',
      ) +
      `</table>`
    );
  };

  let html =
    `<div style="${font};color:#222222;max-width:560px;margin:0 auto;padding:24px 16px">` +
    `<div style="font-size:15px;font-weight:800;color:#0a6fc2">Pay Me Back</div>` +
    `<h1 style="margin:16px 0 4px;font-size:24px">${esc(where)}</h1>` +
    `<div style="color:#6a6a6a;font-size:15px">${esc(date)} · ${state}</div>` +
    shown.map(block).join('');
  if (forLead && report.unclaimed.length > 0) {
    html +=
      `<h2 style="margin:24px 0 4px;font-size:17px">Not claimed yet</h2>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px">` +
      report.unclaimed.map(lineRow).join('') +
      `</table>`;
  }
  if (forLead) {
    html +=
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;margin-top:24px;border-top:2px solid #222222">` +
      row('Bill', money(report.billTotalPence)) +
      row('Collected', money(report.collectedPence)) +
      row('To collect', money(report.toCollectPence)) +
      `</table>`;
  }
  html += `</div>`;

  return { subject, text: t.join('\n'), html };
}
