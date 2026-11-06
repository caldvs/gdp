import { AppError } from '../../errors/AppError.js';
import { baseLogger } from '../../logging/logger.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { guestPhoneStore } from '../../storage/guestPhoneStore.js';
import { guestTextStore, type GuestTextState } from '../../storage/guestTextStore.js';
import { reminderQueue } from '../../storage/reminderQueue.js';
import { countInWindow } from '../../storage/rateCounter.js';
import { maskPhone } from '../messaging/phone.js';
import type { SmsSender } from '../messaging/sms.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Session } from '../../types/sessions.js';
import { paymentsAreOpen } from './allocation.js';
import { paymentsOf, sentPence } from '../payments/ledger.js';
import { loadReport } from './reportService.js';
import type { BillReport, DinerReport } from './report.js';
import { paidText, reminderText } from './texts.js';
import type { AutoRemindResult } from '../../ops/reminders.js';

/**
 * #219/#220: texts to guests about a bill, through AWS SMS (#231), to the
 * number they verified when they joined (#214).
 *
 * - Paid (#220): when the lead marks them received, once per bill, with the
 *   bill's link (`/b/{token}`, 30 days).
 * - Reminders (#219): the lead's *Remind*, at most one a day and three in
 *   all per guest, plus one automatic reminder a day after payments open
 *   (`ops/reminders.ts`, queued when the lead shares the bill). Each carries `/s/{token}` to stop them.
 *
 * Every text is paid, so a bill sends at most `TEXTS_PER_BILL` in all.
 * Numbers are never returned or logged whole.
 */
export const REMINDERS_MAX = 3;
export const TEXTS_PER_BILL = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RemindState =
  /** *Remind* sends a text now. */
  | 'ready'
  /** Reminded in the last day. */
  | 'today'
  /** Three reminders already. */
  | 'used_up'
  /** The guest stopped reminders. */
  | 'stopped'
  /** No verified number (joined before #214, or by account). */
  | 'no_number'
  /** Paid, or says they've paid: nothing to remind. */
  | 'not_owed'
  /** Payments aren't open yet, or the bill was binned. */
  | 'not_open';

export interface GuestRemind {
  remind: RemindState;
  reminders: number;
  lastRemindedAt?: string;
}

export interface LinkView {
  sessionId: string;
  leadName: string;
  venueName?: string;
  dateISO: string;
  settled: boolean;
  billTotalPence: number;
  /** When the link stops working. */
  expiresAt: string;
  diners: (Omit<DinerReport, 'userId'> & { isYou: boolean })[];
  unclaimed: BillReport['unclaimed'];
  unclaimedPence: number;
}

export interface GuestTextDeps {
  sms: SmsSender | null;
  /** https://paymeback.dev, for links. */
  appBaseUrl?: string;
  now?: () => Date;
}

export function createGuestTexts(deps: GuestTextDeps) {
  const now = () => (deps.now ?? (() => new Date()))();
  const host = (deps.appBaseUrl ?? 'https://paymeback.dev')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  /** One text against the bill's cap; false when the bill has used its texts. */
  const countBillText = async (sessionId: string) =>
    (await countInWindow(`TEXTS#${sessionId}`, 60 * 24 * 60 * 60, TEXTS_PER_BILL)).ok;

  /**
   * What a guest still has to send: their share less what they've sent
   * (confirmed, or said they'd paid). A guest who paid and then claimed
   * more owes the difference (#121), and that's what a reminder asks for.
   */
  function leftToPay(session: Session, diner: DinerReport): number {
    const p = session.participants.find((x) => x.userId === diner.userId);
    if (!p) return 0;
    return Math.max(0, diner.totalPence - sentPence(paymentsOf(p, diner.totalPence)));
  }

  function remindStateOf(
    session: Session,
    report: BillReport,
    userId: string,
    state: GuestTextState,
    hasNumber: boolean,
  ): RemindState {
    const diner = report.diners.find((d) => d.userId === userId);
    const open =
      session.status !== 'abandoned' && paymentsAreOpen(session, report.unclaimed.length === 0);
    if (!open) return 'not_open';
    if (!diner || diner.isLead || leftToPay(session, diner) <= 0) {
      return 'not_owed';
    }
    if (!hasNumber) return 'no_number';
    if (state.stoppedAt) return 'stopped';
    if (state.reminders >= REMINDERS_MAX) return 'used_up';
    if (state.lastReminderAt && Date.parse(state.lastReminderAt) > now().getTime() - DAY_MS) {
      return 'today';
    }
    return 'ready';
  }

  /** Text one reminder (already allowed by the caller); false if it couldn't go. */
  async function sendReminder(
    session: Session,
    report: BillReport,
    userId: string,
    phone: string,
    auto: boolean,
  ): Promise<boolean> {
    const at = now().toISOString();
    const reserved = await guestTextStore.reserveReminder(session.sessionId, userId, {
      at,
      notSince: new Date(now().getTime() - DAY_MS).toISOString(),
      max: REMINDERS_MAX,
      auto,
    });
    if (!reserved) return false;
    if (!(await countBillText(session.sessionId))) {
      await guestTextStore.releaseReminder(session.sessionId, userId);
      baseLogger.warn(
        { event: 'texts.bill_cap', sessionId: session.sessionId },
        'Bill has used its texts',
      );
      return false;
    }
    const diner = report.diners.find((d) => d.userId === userId)!;
    const { token } = await guestTextStore.link(session.sessionId, userId);
    const body = reminderText({
      leadName: report.leadName,
      amountPence: leftToPay(session, diner),
      ...(report.venueName ? { venueName: report.venueName } : {}),
      link: `${host}/b/${token}`,
      stopLink: `${host}/s/${token}`,
    });
    try {
      await deps.sms!.send(phone, body);
    } catch (err) {
      await guestTextStore.releaseReminder(session.sessionId, userId);
      throw err;
    }
    baseLogger.info(
      {
        event: 'texts.reminder',
        sessionId: session.sessionId,
        userId,
        to: maskPhone(phone),
        auto,
      },
      'Reminder texted',
    );
    return true;
  }

  async function guestRemind(
    session: Session,
    report: BillReport,
    userId: string,
  ): Promise<GuestRemind> {
    const [state, phone] = await Promise.all([
      guestTextStore.get(session.sessionId, userId),
      guestPhoneStore.get(session.sessionId, userId),
    ]);
    return {
      remind: remindStateOf(session, report, userId, state, !!phone),
      reminders: state.reminders,
      ...(state.lastReminderAt ? { lastRemindedAt: state.lastReminderAt } : {}),
    };
  }

  async function leadSession(caller: VerifiedCaller, sessionId: string): Promise<Session> {
    const session = await sessionStore.get(sessionId);
    if (!session || session.creatorUserId !== caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    return session;
  }

  return {
    enabled: deps.sms !== null,

    /**
     * #220: the lead marked this guest received. Texts them once, with the
     * bill's link. Never throws: the payment is marked either way.
     */
    async paid(sessionId: string, userId: string): Promise<void> {
      if (!deps.sms) return;
      try {
        const phone = await guestPhoneStore.get(sessionId, userId);
        if (!phone) return;
        const session = await sessionStore.get(sessionId);
        if (!session || userId === session.creatorUserId) return;
        const report = await loadReport(session);
        const diner = report.diners.find((d) => d.userId === userId);
        if (diner?.paid.kind !== 'paid') return;
        if (!(await guestTextStore.reservePaid(sessionId, userId, now().toISOString()))) return;
        if (!(await countBillText(sessionId))) {
          await guestTextStore.releasePaid(sessionId, userId);
          return;
        }
        const { token, ttlAt } = await guestTextStore.link(sessionId, userId);
        const body = paidText({
          leadName: report.leadName,
          amountPence: diner.paid.amountPence,
          ...(report.venueName ? { venueName: report.venueName } : {}),
          link: `${host}/b/${token}`,
          untilEpochSeconds: ttlAt,
        });
        try {
          await deps.sms.send(phone, body);
        } catch (err) {
          await guestTextStore.releasePaid(sessionId, userId);
          throw err;
        }
        baseLogger.info(
          { event: 'texts.paid', sessionId, userId, to: maskPhone(phone) },
          'Paid text sent',
        );
      } catch (err) {
        baseLogger.error(
          { event: 'texts.paid_failed', sessionId, userId, err },
          'Paid text failed',
        );
      }
    },

    /** #219: what *Remind* would do for each guest. The lead only. */
    async states(
      caller: VerifiedCaller,
      sessionId: string,
    ): Promise<{ enabled: boolean; guests: Record<string, GuestRemind> }> {
      const session = await leadSession(caller, sessionId);
      if (!deps.sms) return { enabled: false, guests: {} };
      const report = await loadReport(session);
      const guests: Record<string, GuestRemind> = {};
      for (const p of session.participants) {
        if (p.userId === session.creatorUserId) continue;
        guests[p.userId] = await guestRemind(session, report, p.userId);
      }
      return { enabled: true, guests };
    },

    /** #219: the lead taps *Remind* on a guest. */
    async remind(caller: VerifiedCaller, sessionId: string, userId: string): Promise<GuestRemind> {
      const session = await leadSession(caller, sessionId);
      if (!deps.sms) throw new AppError('CHANNEL_UNAVAILABLE', 'Texts aren’t available here');
      if (!session.participants.some((p) => p.userId === userId)) {
        throw new AppError('NOT_FOUND', 'Not at this table');
      }
      const report = await loadReport(session);
      const before = await guestRemind(session, report, userId);
      if (before.remind === 'today') {
        throw new AppError('RATE_LIMITED', 'Reminded today. Try again tomorrow.');
      }
      if (before.remind === 'used_up') {
        throw new AppError('RATE_LIMITED', `Reminded ${REMINDERS_MAX} times already.`);
      }
      if (before.remind !== 'ready') {
        throw new AppError('SESSION_INVALID_STATE', `Can't remind: ${before.remind}`);
      }
      const phone = (await guestPhoneStore.get(sessionId, userId))!;
      if (!(await sendReminder(session, report, userId, phone, false))) {
        throw new AppError('RATE_LIMITED', 'Can’t send another reminder for this bill.');
      }
      return guestRemind(session, report, userId);
    },

    /** #219: the lead shared the bill: queue its automatic reminder. */
    async queueAuto(sessionId: string): Promise<void> {
      if (!deps.sms) return;
      try {
        await reminderQueue.add(sessionId);
      } catch (err) {
        // A missed automatic reminder isn't worth failing the share for.
        baseLogger.warn({ event: 'texts.queue_failed', sessionId, err }, 'Reminder not queued');
      }
    },

    /**
     * #219: the automatic reminder, a day after payments open: one text to
     * each guest who still hasn't paid and hasn't had a reminder in the last
     * day. `opened`: open, and nobody noted when (payments opened by the
     * last claim, not the lead); the job notes it and comes back tomorrow.
     */
    async autoRemind(sessionId: string, openSeenAt?: string): Promise<AutoRemindResult> {
      if (!deps.sms) return 'done';
      const session = await sessionStore.get(sessionId);
      if (!session || session.status === 'abandoned') return 'done';
      const report = await loadReport(session);
      if (!paymentsAreOpen(session, report.unclaimed.length === 0)) return 'wait';
      const openSince = session.paymentsOpenedAt ?? openSeenAt;
      if (!openSince) return 'opened';
      // An hour's slack, so a daily run a day after the last one counts.
      if (Date.parse(openSince) > now().getTime() - DAY_MS + 60 * 60 * 1000) return 'wait';
      for (const p of session.participants) {
        if (p.userId === session.creatorUserId) continue;
        const r = await guestRemind(session, report, p.userId);
        if (r.remind !== 'ready') continue;
        const phone = (await guestPhoneStore.get(sessionId, p.userId))!;
        await sendReminder(session, report, p.userId, phone, true);
      }
      return 'done';
    },

    /** #220 G5: the bill behind a guest's link, read-only. No numbers, no bank details. */
    async linkView(token: string): Promise<LinkView> {
      const link = await guestTextStore.resolve(token);
      const session = link && (await sessionStore.get(link.sessionId));
      if (!link || !session || session.status === 'abandoned') {
        throw new AppError('NOT_FOUND', 'This link has expired');
      }
      const report = await loadReport(session, { keepUnclaimed: true });
      return {
        sessionId: session.sessionId,
        leadName: report.leadName,
        ...(report.venueName ? { venueName: report.venueName } : {}),
        dateISO: report.dateISO,
        settled: report.settled,
        billTotalPence: report.billTotalPence,
        expiresAt: new Date(link.ttlAt * 1000).toISOString(),
        diners: report.diners.map(({ userId, ...d }) => ({ ...d, isYou: userId === link.userId })),
        unclaimed: report.unclaimed,
        unclaimedPence: report.unclaimedPence,
      };
    },

    /** #219: `/s/{token}`: no more reminders for this bill. */
    async stop(token: string): Promise<void> {
      const link = await guestTextStore.resolve(token);
      if (!link) throw new AppError('NOT_FOUND', 'This link has expired');
      await guestTextStore.stop(link.sessionId, link.userId, now().toISOString());
      baseLogger.info(
        { event: 'texts.stopped', sessionId: link.sessionId, userId: link.userId },
        'Reminders stopped',
      );
    },
  };
}

export type GuestTexts = ReturnType<typeof createGuestTexts>;
