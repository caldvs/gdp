import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { paymentStore } from '../../storage/paymentStore.js';
import { userStore } from '../../storage/userStore.js';
import { baseLogger } from '../../logging/logger.js';
import { buildReport, renderReportEmail, type BillReport } from './report.js';
import { renderLeadEmail, renderProofEmail } from './leadEmail.js';
import { leadMailQueue } from '../../storage/leadMailQueue.js';
import type { EmailSender } from '../email/sender.js';
import type { Session } from '../../types/sessions.js';

/** Loads what a report needs and emails it. */
export const createReportService = (deps: { emailSender: EmailSender; appBaseUrl?: string }) => {
  async function load(
    session: Session,
    opts: { keepUnclaimed?: boolean } = {},
  ): Promise<BillReport> {
    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    const paymentIds = session.participants.flatMap((p) =>
      'paymentId' in p.payment ? [p.payment.paymentId] : [],
    );
    const payments = await Promise.all(paymentIds.map((id) => paymentStore.get(id)));
    const amounts = new Map(
      payments.flatMap((p) => (p ? [[p.paymentId, p.amountPence] as const] : [])),
    );
    return buildReport(session, bill, amounts, opts);
  }

  async function sendTo(report: BillReport, userId: string, sessionId: string): Promise<boolean> {
    const user = await userStore.get(userId);
    if (!user?.email) return false;
    const email = renderReportEmail(report, userId);
    await deps.emailSender.send({
      to: user.email,
      subject: email.subject,
      category: 'report',
      body: { text: email.text, html: email.html },
    });
    baseLogger.info({ event: 'report.sent', sessionId, userId }, 'Bill report emailed');
    return true;
  }

  return {
    /** Email the caller their report. The lead's covers everyone. */
    async emailToCaller(input: { sessionId: string; userId: string }): Promise<void> {
      const session = await sessionStore.get(input.sessionId);
      const onBill = session?.participants.some((p) => p.userId === input.userId);
      if (!session || !onBill) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      if (session.status === 'setup' || session.status === 'abandoned') {
        throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}; no report`);
      }
      const sent = await sendTo(await load(session), input.userId, session.sessionId);
      if (!sent) throw new AppError('INVALID_INPUT', 'No email address on your account');
    },

    /**
     * #221/#226: a guest sent a screenshot of their payment. The lead gets a
     * link to the bill, never the image. A failure is logged, not thrown:
     * the screenshot is saved either way.
     */
    async emailProofArrived(sessionId: string, guestName: string): Promise<void> {
      try {
        const session = await sessionStore.get(sessionId);
        const lead = session && (await userStore.get(session.creatorUserId));
        if (!session || !lead?.email) return;
        const base = (deps.appBaseUrl ?? 'https://paymeback.dev').replace(/\/$/, '');
        const email = renderProofEmail({
          guestName,
          venueName: session.venue?.name,
          openUrl: `${base}/session/${sessionId}`,
        });
        await deps.emailSender.send({
          to: lead.email,
          subject: email.subject,
          category: 'proof',
          body: { text: email.text, html: email.html },
        });
      } catch (err) {
        baseLogger.error({ event: 'proof_email.failed', sessionId, err }, 'Proof email failed');
      }
    },

    /** #221: settled; the lead's email goes the next morning (`sendLeadEmail`). */
    async queueLeadEmail(sessionId: string): Promise<void> {
      try {
        await leadMailQueue.add(sessionId, new Date().toISOString());
      } catch (err) {
        baseLogger.error(
          { event: 'lead_email.queue_failed', sessionId, err },
          'Lead email not queued',
        );
      }
    },

    /** #221 E1/E2: the lead's email about a settled bill. `false` if there's nothing to send. */
    async sendLeadEmail(sessionId: string): Promise<boolean> {
      const session = await sessionStore.get(sessionId);
      if (!session || session.status !== 'settled') return false;
      const lead = await userStore.get(session.creatorUserId);
      if (!lead?.email) return false;
      const report = await load(session, { keepUnclaimed: true });
      const base = (deps.appBaseUrl ?? 'https://paymeback.dev').replace(/\/$/, '');
      const email = renderLeadEmail(report, `${base}/session/${sessionId}`);
      await deps.emailSender.send({
        to: lead.email,
        subject: email.subject,
        category: 'lead-settled',
        body: { text: email.text, html: email.html },
      });
      baseLogger.info({ event: 'lead_email.sent', sessionId }, 'Lead email sent');
      return true;
    },
  };
};

export type ReportService = ReturnType<typeof createReportService>;
