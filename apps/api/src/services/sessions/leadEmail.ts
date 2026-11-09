import { esc, when, type BillReport } from './report.js';

/**
 * #221: the lead's email the day after *Mark as settled*. Only a notice
 * that the bill's summary is ready in the app, with a link to it: no
 * amounts, names or lines (Callum, 9 Nov 2026), so it's short and nothing
 * about the table sits in an inbox. Tables and inline styles only, plus a
 * plain-text part, so it holds up in Gmail and Outlook.
 */
export type LeadEmail = { subject: string; text: string; html: string };

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export function leadSubject(report: BillReport): string {
  return report.venueName
    ? `Your bill summary for ${report.venueName} is ready`
    : 'Your bill summary is ready';
}

export function renderLeadEmail(report: BillReport, openUrl: string): LeadEmail {
  const subject = leadSubject(report);
  const where = report.venueName ?? 'Your bill';
  const line = 'See who paid what in the app.';
  const text = [
    subject,
    `${where} · ${when(report.dateISO)}`,
    '',
    line,
    '',
    `Open the bill: ${openUrl}`,
  ].join('\n');
  const font = 'font-family:Arial,Helvetica,sans-serif';
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;${font};color:#111111"><tr><td>` +
    `<p style="margin:0;font-size:15px;font-weight:bold;color:#0a6fc2">Pay Me Back</p>` +
    `<h1 style="margin:16px 0 4px;font-size:22px;line-height:1.3;color:#111111">${esc(subject)}</h1>` +
    `<p style="margin:0 0 8px;font-size:15px;color:#555555">${esc(where)} · ${esc(when(report.dateISO))}</p>` +
    `<p style="margin:0;font-size:15px;color:#555555">${line}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td bgcolor="#e02a0a" style="border-radius:8px">` +
    `<a href="${esc(openUrl)}" style="display:inline-block;padding:14px 24px;${font};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">Open the bill</a>` +
    `</td></tr></table>` +
    `<p style="margin:0;font-size:13px;color:#555555">You’re getting this because you settled this bill on Pay Me Back.</p>` +
    `</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
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
