import type { EmailSender } from '../email/sender.js';
import { userStore } from '../../storage/userStore.js';
import { esc, money } from '../sessions/report.js';

/**
 * #228: the email the lead gets when their bank wants them to confirm the
 * round-ups charge at settle (it was made while they were away). It links to
 * the page that confirms it. Never carries card details.
 */
export function renderConfirmChargeEmail(input: { amountPence: number; confirmUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const amount = money(input.amountPence);
  const subject = `Confirm your ${amount} platform fee`;
  const text = [
    `Your bank wants you to confirm the ${amount} platform fee on your card.`,
    '',
    'It’s your guests’ round-ups: they paid them to you with their share, so you pay nothing towards it. Your £1 hold is released.',
    '',
    `Confirm it: ${input.confirmUrl}`,
    '',
    'Pay Me Back',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#222222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:12px;">Confirm your ${esc(amount)} platform fee</td></tr>
<tr><td style="font-size:16px;line-height:24px;padding-bottom:12px;">Your bank wants you to confirm it.</td></tr>
<tr><td style="font-size:16px;line-height:24px;color:#555555;padding-bottom:20px;">It’s your guests’ round-ups: they paid them to you with their share, so you pay nothing towards it. Your £1 hold is released.</td></tr>
<tr><td><a href="${esc(input.confirmUrl)}" style="display:inline-block;background:#e02a0a;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:4px;">Confirm ${esc(amount)}</a></td></tr>
</table></body></html>`;
  return { subject, text, html };
}

/** Sends it to the lead's email, if they have one (a phone account may not). */
export const confirmChargeEmailer =
  (sender: EmailSender) =>
  async (input: { userId: string; amountPence: number; confirmUrl: string }): Promise<void> => {
    const lead = await userStore.get(input.userId);
    if (!lead?.email) return;
    const email = renderConfirmChargeEmail(input);
    await sender.send({
      to: lead.email,
      subject: email.subject,
      body: { text: email.text, html: email.html },
      category: 'fee-confirm',
    });
  };
