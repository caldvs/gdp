import type { QueuedLeadMail } from '../storage/leadMailQueue.js';

/**
 * #221: once a day (09:00 UTC), email each lead who settled a bill before
 * today (London) how it ended. Runs in the API Lambda when EventBridge
 * invokes it with `{ "gdpLeadEmails": true }`; API Gateway never sends
 * that shape. A failed send keeps its row for tomorrow and is reported.
 */
export const isLeadEmailsEvent = (event: unknown): boolean =>
  typeof event === 'object' &&
  event !== null &&
  (event as { gdpLeadEmails?: unknown }).gdpLeadEmails === true;

export interface LeadEmailsDeps {
  queue: {
    due(before: string): Promise<QueuedLeadMail[]>;
    remove(item: QueuedLeadMail): Promise<void>;
  };
  /** `false`: nothing to send (bill gone, no email address); the row is dropped. */
  send(sessionId: string): Promise<boolean>;
  now?: () => Date;
}

export interface LeadEmailsReport {
  due: number;
  sent: number;
  skipped: number;
  failed: { sessionId: string; error: string }[];
}

/** Midnight in London today, as a UTC ISO string: bills settled before it are due. */
export function startOfLondonDay(now: Date): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // London is UTC or UTC+1: try both and keep the one that is London midnight.
  for (const offset of ['+00:00', '+01:00']) {
    const d = new Date(`${ymd}T00:00:00${offset}`);
    const back = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d);
    if (back === '00') return d.toISOString();
  }
  return new Date(`${ymd}T00:00:00Z`).toISOString();
}

export async function runLeadEmails(deps: LeadEmailsDeps): Promise<LeadEmailsReport> {
  const now = (deps.now ?? (() => new Date()))();
  const items = await deps.queue.due(startOfLondonDay(now));
  const report: LeadEmailsReport = { due: items.length, sent: 0, skipped: 0, failed: [] };
  for (const item of items) {
    try {
      if (await deps.send(item.sessionId)) report.sent += 1;
      else report.skipped += 1;
      await deps.queue.remove(item);
    } catch (err) {
      report.failed.push({ sessionId: item.sessionId, error: (err as Error).message });
    }
  }
  return report;
}
