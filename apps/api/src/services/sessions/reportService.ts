import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { paymentStore } from '../../storage/paymentStore.js';
import { userStore } from '../../storage/userStore.js';
import { baseLogger } from '../../logging/logger.js';
import { buildReport, renderReportEmail, type BillReport } from './report.js';
import type { EmailSender } from '../email/sender.js';
import type { Session } from '../../types/sessions.js';

/** Loads what a report needs and emails it. */
export const createReportService = (deps: { emailSender: EmailSender }) => {
  async function load(session: Session): Promise<BillReport> {
    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    const paymentIds = session.participants.flatMap((p) =>
      'paymentId' in p.payment ? [p.payment.paymentId] : [],
    );
    const payments = await Promise.all(paymentIds.map((id) => paymentStore.get(id)));
    const amounts = new Map(
      payments.flatMap((p) => (p ? [[p.paymentId, p.amountPence] as const] : [])),
    );
    return buildReport(session, bill, amounts);
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
     * Email every diner their report. Called once, when the lead closes the
     * bill. A failure for one diner is logged and doesn't stop the others,
     * or the close.
     */
    async emailEveryone(sessionId: string): Promise<void> {
      try {
        const session = await sessionStore.get(sessionId);
        if (!session) return;
        const report = await load(session);
        const results = await Promise.allSettled(
          session.participants.map((p) => sendTo(report, p.userId, sessionId)),
        );
        for (const r of results) {
          if (r.status === 'rejected') {
            baseLogger.error(
              { event: 'report.failed', sessionId, err: r.reason },
              'Report email failed',
            );
          }
        }
      } catch (err) {
        baseLogger.error({ event: 'report.failed', sessionId, err }, 'Report emails failed');
      }
    },
  };
};

export type ReportService = ReturnType<typeof createReportService>;
