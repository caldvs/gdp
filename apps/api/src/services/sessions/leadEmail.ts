import { esc, money, when, type BillReport, type DinerReport } from './report.js';

/**
 * #221 E1/E2: the lead's email the day after *Mark as settled*. The
 * subject says how it ended ("Everyone's paid for Gennaro", "Tom still
 * owes you £25.31 for Gennaro"); the body gives the lead's share, each
 * guest and what they paid, and lines nobody claimed, which weren't paid
 * back, in their own section. Tables and inline styles only, no web fonts
 * or masks, so it holds up in Gmail and Outlook; plus a plain-text part.
 */
export type LeadEmail = { subject: string; text: string; html: string };

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** What the guest still owes: nothing once the lead has it. */
const owes = (d: DinerReport) => (d.paid.kind === 'paid' ? 0 : d.totalPence);

function status(d: DinerReport): { text: string; tone: 'ok' | 'warn' } {
  switch (d.paid.kind) {
    case 'paid':
      return { text: `Paid ${money(d.paid.amountPence)}`, tone: 'ok' };
    case 'says_paid':
      return { text: `Says they’ve paid ${money(d.paid.amountPence)}`, tone: 'warn' };
    default:
      return { text: `Owes ${money(d.totalPence)}`, tone: 'warn' };
  }
}

export function leadSubject(report: BillReport): string {
  const where = report.venueName ?? 'your bill';
  const owing = report.diners.filter((d) => !d.isLead && d.paid.kind === 'not_paid');
  const saying = report.diners.filter((d) => !d.isLead && d.paid.kind === 'says_paid');
  if (owing.length === 1) {
    return `${first(owing[0]!.displayName)} still owes you ${money(owes(owing[0]!))} for ${where}`;
  }
  if (owing.length > 1) {
    const total = owing.reduce((a, d) => a + owes(d), 0);
    return `${owing.length} people still owe you ${money(total)} for ${where}`;
  }
  if (saying.length > 0) {
    return `Check ${saying.length === 1 ? `${first(saying[0]!.displayName)}’s payment` : `${saying.length} payments`} for ${where}`;
  }
  return `Everyone’s paid for ${where}`;
}

export function renderLeadEmail(report: BillReport, openUrl: string): LeadEmail {
  const lead = report.diners.find((d) => d.isLead);
  const guests = report.diners.filter((d) => !d.isLead);
  const where = report.venueName ?? 'Your bill';
  const date = when(report.dateISO);
  const subject = leadSubject(report);

  // Plain text
  const t: string[] = [subject, `${where} · ${date}`, ''];
  if (lead) t.push(`Your share  ${money(lead.totalPence)}`, '');
  for (const d of guests) t.push(`${d.displayName}  ${status(d).text}`);
  if (guests.length === 0) t.push('Nobody joined.');
  if (report.unclaimed.length > 0) {
    t.push('', 'Nobody claimed (not paid back)');
    for (const l of report.unclaimed)
      t.push(`  ${l.name}${l.detail ? ` (${l.detail})` : ''}  ${money(l.pence)}`);
    t.push(`  With service and tax  ${money(report.unclaimedPence)}`);
  }
  t.push(
    '',
    `Bill ${money(report.billTotalPence)} · Back from friends ${money(report.collectedPence)}`,
  );
  t.push('', `Open the bill: ${openUrl}`, '', 'Pay Me Back · You settled this bill.');

  // HTML: one table, inline styles. Footer #555555 on white is 7.5:1.
  const font = 'font-family:Arial,Helvetica,sans-serif';
  const row = (left: string, right: string, style = '') =>
    `<tr><td style="padding:8px 0;${style}">${left}</td><td align="right" style="padding:8px 0;text-align:right;white-space:nowrap;${style}">${right}</td></tr>`;
  const tone = { ok: '#116329', warn: '#8a4b00' };
  const table = (rows: string, extra = '') =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:15px;${extra}">${rows}</table>`;

  let body =
    `<p style="margin:0;font-size:15px;font-weight:bold;color:#0a6fc2">Pay Me Back</p>` +
    `<h1 style="margin:16px 0 4px;font-size:22px;line-height:1.3;color:#111111">${esc(subject)}</h1>` +
    `<p style="margin:0 0 16px;font-size:15px;color:#555555">${esc(where)} · ${esc(date)}</p>`;
  if (lead)
    body += table(
      row(
        '<b>Your share</b>',
        `<b>${money(lead.totalPence)}</b>`,
        'border-bottom:1px solid #d0d7de',
      ),
    );
  body += table(
    guests.length
      ? guests
          .map((d) => {
            const st = status(d);
            return row(
              esc(d.displayName),
              `<span style="color:${tone[st.tone]}">${esc(st.text)}</span>`,
              'border-bottom:1px solid #eeeeee',
            );
          })
          .join('')
      : row('<span style="color:#555555">Nobody joined.</span>', ''),
  );
  if (report.unclaimed.length > 0) {
    body +=
      `<h2 style="margin:24px 0 2px;font-size:17px;color:#111111">Nobody claimed</h2>` +
      `<p style="margin:0 0 4px;font-size:14px;color:#8a4b00">Not paid back. Ask the table who had them.</p>` +
      table(
        report.unclaimed
          .map((l) =>
            row(
              `${esc(l.name)}${l.detail ? ` <span style="color:#555555">${esc(l.detail)}</span>` : ''}`,
              money(l.pence),
            ),
          )
          .join('') +
          row(
            '<span style="color:#555555">With service and tax</span>',
            money(report.unclaimedPence),
            'border-top:1px solid #d0d7de',
          ),
      );
  }
  body += table(
    row('Bill', money(report.billTotalPence)) +
      row('Back from friends', money(report.collectedPence)),
    'margin-top:20px;border-top:2px solid #111111',
  );
  body +=
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td bgcolor="#e02a0a" style="border-radius:8px">` +
    `<a href="${esc(openUrl)}" style="display:inline-block;padding:14px 24px;${font};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">Open the bill</a>` +
    `</td></tr></table>` +
    `<p style="margin:0;font-size:13px;color:#555555">You’re getting this because you settled this bill on Pay Me Back.</p>`;

  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;${font};color:#111111"><tr><td>` +
    body +
    `</td></tr></table></td></tr></table></body></html>`;

  return { subject, text: t.join('\n'), html };
}

/** #226: a guest sent a screenshot. Says so and links to the bill; never the image. */
export function renderProofEmail(input: {
  guestName: string;
  venueName?: string | undefined;
  openUrl: string;
}): LeadEmail {
  const where = input.venueName ?? 'your bill';
  const subject = `${first(input.guestName)} sent a screenshot of their payment for ${where}`;
  const text = [
    subject,
    '',
    'Check it in the app, then mark them received once the money is in your account.',
    '',
    `Open the bill: ${input.openUrl}`,
  ].join('\n');
  const font = 'font-family:Arial,Helvetica,sans-serif';
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;${font};color:#111111"><tr><td>` +
    `<p style="margin:0;font-size:15px;font-weight:bold;color:#0a6fc2">Pay Me Back</p>` +
    `<h1 style="margin:16px 0 8px;font-size:22px;line-height:1.3">${esc(subject)}</h1>` +
    `<p style="margin:0;font-size:15px;color:#555555">Check it in the app, then mark them received once the money is in your account.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td bgcolor="#e02a0a" style="border-radius:8px">` +
    `<a href="${esc(input.openUrl)}" style="display:inline-block;padding:14px 24px;${font};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">Open the bill</a>` +
    `</td></tr></table>` +
    `</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
