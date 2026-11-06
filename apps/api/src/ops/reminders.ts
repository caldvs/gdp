import type { QueuedReminder } from '../storage/reminderQueue.js';

/**
 * #219: once a day (10:00 UTC), the automatic reminder. Each shared bill is
 * queued; the first run that finds its payments open notes it, and a run at
 * least a day after that texts each guest who still owes (one text each,
 * never more than the lead's reminders allow). Runs in the API Lambda when
 * EventBridge invokes it with `{ "gdpReminders": true }`; API Gateway never
 * sends that shape.
 */
export const isRemindersEvent = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  (event as { gdpReminders?: unknown }).gdpReminders === true;

export type AutoRemindResult = 'done' | 'wait' | 'opened';

export interface RemindersDeps {
  queue: {
    all(): Promise<QueuedReminder[]>;
    markOpen(sessionId: string, at: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
  };
  /** `opened`: payments are open and nobody noted when; `wait`: not yet; `done`: drop the row. */
  autoRemind(sessionId: string, openSeenAt: string | undefined): Promise<AutoRemindResult>;
  now?: () => Date;
}

export interface RemindersReport {
  queued: number;
  done: number;
  opened: number;
  waiting: number;
  failed: { sessionId: string; error: string }[];
}

export async function runReminders(deps: RemindersDeps): Promise<RemindersReport> {
  const now = (deps.now ?? (() => new Date()))();
  const items = await deps.queue.all();
  const report: RemindersReport = {
    queued: items.length,
    done: 0,
    opened: 0,
    waiting: 0,
    failed: [],
  };
  for (const item of items) {
    try {
      const r = await deps.autoRemind(item.sessionId, item.openSeenAt);
      if (r === 'done') {
        await deps.queue.remove(item.sessionId);
        report.done += 1;
      } else if (r === 'opened') {
        await deps.queue.markOpen(item.sessionId, now.toISOString());
        report.opened += 1;
      } else report.waiting += 1;
    } catch (err) {
      report.failed.push({ sessionId: item.sessionId, error: (err as Error).message });
    }
  }
  return report;
}
