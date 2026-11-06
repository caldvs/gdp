import { describe, expect, it } from 'vitest';
import { isRemindersEvent, runReminders, type AutoRemindResult } from './reminders.js';

function queue(ids: string[]) {
  const rows = new Map<string, { openSeenAt?: string }>(ids.map((id) => [id, {}]));
  return {
    rows,
    all: () => Promise.resolve([...rows].map(([sessionId, r]) => ({ sessionId, ...r }))),
    markOpen: (id: string, at: string) => {
      rows.get(id)!.openSeenAt = at;
      return Promise.resolve();
    },
    remove: (id: string) => {
      rows.delete(id);
      return Promise.resolve();
    },
  };
}

describe('#219 daily reminders', () => {
  it('only its own event shape', () => {
    expect(isRemindersEvent({ gdpReminders: true })).toBe(true);
    expect(isRemindersEvent({ gdpReminders: 'yes' })).toBe(false);
    expect(isRemindersEvent(null)).toBe(false);
    expect(isRemindersEvent({ version: '2.0', rawPath: '/' })).toBe(false);
  });

  it('notes open bills, keeps waiting ones, drops done ones, and keeps failures for tomorrow', async () => {
    const q = queue(['a', 'b', 'c', 'd']);
    const results: Record<string, AutoRemindResult | Error> = {
      a: 'opened',
      b: 'wait',
      c: 'done',
      d: new Error('boom'),
    };
    const now = new Date('2026-11-09T10:00:00Z');
    const report = await runReminders({
      queue: q,
      autoRemind: (id) => {
        const r = results[id]!;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
      now: () => now,
    });
    expect(report).toEqual({
      queued: 4,
      done: 1,
      opened: 1,
      waiting: 1,
      failed: [{ sessionId: 'd', error: 'boom' }],
    });
    expect(q.rows.get('a')).toEqual({ openSeenAt: now.toISOString() });
    expect(q.rows.has('c')).toBe(false);
    expect(q.rows.has('d')).toBe(true);
  });

  it('passes what it saw before', async () => {
    const q = queue(['a']);
    q.rows.get('a')!.openSeenAt = '2026-11-08T10:00:00.000Z';
    const seen: (string | undefined)[] = [];
    await runReminders({
      queue: q,
      autoRemind: (_id, s) => {
        seen.push(s);
        return Promise.resolve('done');
      },
    });
    expect(seen).toEqual(['2026-11-08T10:00:00.000Z']);
  });
});
