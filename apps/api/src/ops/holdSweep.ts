import type { CaptureOutcome, RefundOutcome, TableFee } from '../services/billing/tableFee.js';
import type { PendingHold } from '../storage/tableFeeStore.js';
import type { Session } from '../types/sessions.js';

/**
 * The daily hold sweep (#168). A card hold lapses after about 7 days, so a
 * bill still open by then would never pay its platform fee. Once a day this
 * looks at every hold spent on a share and not yet settled:
 *
 * - On a bill still open, a hold older than 6 days has the guests' part
 *   taken now (the same rules as close: at most the hold, released under
 *   30p). The bill stays open; closing it later takes nothing more.
 * - On a bill already closed or binned whose hold wasn't settled (Stripe
 *   failed at close), it tries again: closed takes the guests' part,
 *   binned releases it.
 * - Nobody joined: the hold is released.
 *
 * A hold that saved the lead's card (#228) is never taken from: on a bill
 * still open after 6 days it's released (the charge waits for settle, on the
 * saved card); a settled bill whose charge or release didn't happen at close
 * gets them now. Its index row stays until both are done, so a failed settle
 * is retried; a bill never settled is never charged, and its row goes when
 * the session expires.
 *
 * Runs in the API Lambda when EventBridge invokes it with
 * `{ "gdpHoldSweep": true }`. API Gateway never sends that shape.
 */

export const SWEEP_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

export const isHoldSweepEvent = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  (event as { gdpHoldSweep?: unknown }).gdpHoldSweep === true;

export interface HoldSweepDeps {
  holds: { list(): Promise<PendingHold[]>; clear(billId: string): Promise<void> };
  getFee(billId: string): Promise<TableFee | null>;
  getSession(sessionId: string): Promise<Session | null>;
  guestsFeePence(sessionId: string): Promise<number>;
  tableFees: {
    refundIfNobodyJoined(session: Session): Promise<RefundOutcome>;
    /** #228: cancels a saved-card hold before it lapses; the charge waits for settle. */
    releaseBeforeLapse(fee: TableFee): Promise<RefundOutcome>;
    takeFromHold(
      session: Pick<Session, 'sessionId' | 'billId' | 'creatorUserId' | 'participants'>,
      guestsFeePence: number,
    ): Promise<CaptureOutcome>;
  };
  now?: () => Date;
}

export interface HoldSweepReport {
  looked: number;
  /** Settled before the sweep got to them (at close): the index row is cleared. */
  alreadySettled: number;
  /** Open and younger than 6 days: left for another day. */
  waiting: number;
  captured: number;
  released: number;
  failed: { billId: string; error: string }[];
}

const OPEN: ReadonlyArray<Session['status']> = ['setup', 'claiming', 'paying'];

export async function runHoldSweep(deps: HoldSweepDeps): Promise<HoldSweepReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: HoldSweepReport = {
    looked: 0,
    alreadySettled: 0,
    waiting: 0,
    captured: 0,
    released: 0,
    failed: [],
  };

  for (const hold of await deps.holds.list()) {
    report.looked += 1;
    try {
      const fee = await deps.getFee(hold.billId);
      if (fee && fee.sessionId === hold.sessionId && fee.paymentMethodId && fee.customerId) {
        const outcome = await sweepSavedCard(deps, now, hold, fee);
        if (outcome === 'waiting') report.waiting += 1;
        else if (outcome === 'released') report.released += 1;
        else if (outcome === 'charged') report.captured += 1;
        else report.alreadySettled += 1;
        continue;
      }
      if (
        !fee ||
        fee.sessionId !== hold.sessionId ||
        fee.capturedAt ||
        fee.releasedAt ||
        fee.refundedAt
      ) {
        report.alreadySettled += 1;
        await deps.holds.clear(hold.billId);
        continue;
      }
      const session = await deps.getSession(hold.sessionId);
      const open = !!session && OPEN.includes(session.status);
      if (open && now.getTime() - Date.parse(hold.heldAt) < SWEEP_AFTER_MS) {
        report.waiting += 1;
        continue;
      }

      let outcome: CaptureOutcome | RefundOutcome;
      if (!session) {
        // The session has gone (TTL): nothing can be worked out, so take nothing.
        outcome = await deps.tableFees.takeFromHold(
          { sessionId: hold.sessionId, billId: hold.billId, creatorUserId: '', participants: [] },
          0,
        );
      } else {
        outcome = await deps.tableFees.refundIfNobodyJoined(session);
        if (outcome === 'guests_joined') {
          const owed =
            session.status === 'abandoned' ? 0 : await deps.guestsFeePence(session.sessionId);
          outcome = await deps.tableFees.takeFromHold(session, owed);
        }
      }

      if (outcome === 'captured') report.captured += 1;
      else if (outcome === 'released' || outcome === 'lapsed') report.released += 1;
      else report.alreadySettled += 1;
      await deps.holds.clear(hold.billId);
    } catch (err) {
      report.failed.push({ billId: hold.billId, error: (err as Error).message });
    }
  }
  return report;
}

/**
 * #228: a hold that saved the lead's card. Open bill: release it once it's
 * 6 days old and keep watching. Settled: charge and release, whichever is
 * still to do. Binned, or the session gone: release, charge nothing.
 */
async function sweepSavedCard(
  deps: HoldSweepDeps,
  now: Date,
  hold: PendingHold,
  fee: TableFee,
): Promise<'waiting' | 'released' | 'charged' | 'settled'> {
  if (fee.refundedAt || fee.capturedAt || (fee.releasedAt && fee.chargeStatus)) {
    await deps.holds.clear(hold.billId);
    return 'settled';
  }
  const session = await deps.getSession(hold.sessionId);
  if (session && OPEN.includes(session.status)) {
    if (fee.releasedAt || now.getTime() - Date.parse(hold.heldAt) < SWEEP_AFTER_MS) {
      return 'waiting';
    }
    const released = await deps.tableFees.releaseBeforeLapse(fee);
    return released === 'released' ? 'released' : 'waiting';
  }
  if (!session || session.status === 'abandoned') {
    if (!fee.releasedAt) await deps.tableFees.releaseBeforeLapse(fee);
    await deps.holds.clear(hold.billId);
    return 'released';
  }
  // Settled.
  const nobody = await deps.tableFees.refundIfNobodyJoined(session);
  if (nobody !== 'guests_joined') {
    await deps.holds.clear(hold.billId);
    return 'released';
  }
  const outcome = await deps.tableFees.takeFromHold(
    session,
    await deps.guestsFeePence(session.sessionId),
  );
  await deps.holds.clear(hold.billId);
  return outcome === 'charged' ? 'charged' : outcome === 'released' ? 'released' : 'settled';
}
