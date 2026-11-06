import { describe, expect, it, vi } from 'vitest';
import { isLeadEmailsEvent, runLeadEmails, startOfLondonDay } from './leadEmails.js';

describe('#221 lead emails job', () => {
  it('knows its event', () => {
    expect(isLeadEmailsEvent({ gdpLeadEmails: true })).toBe(true);
    expect(isLeadEmailsEvent({ gdpLeadEmails: 'yes' })).toBe(false);
    expect(isLeadEmailsEvent(null)).toBe(false);
  });

  it('London midnight, winter and summer', () => {
    expect(startOfLondonDay(new Date('2026-11-08T09:00:00Z'))).toBe('2026-11-08T00:00:00.000Z');
    expect(startOfLondonDay(new Date('2026-07-08T09:00:00Z'))).toBe('2026-07-07T23:00:00.000Z');
    // 23:30 UTC on 7 July is already the 8th in London.
    expect(startOfLondonDay(new Date('2026-07-07T23:30:00Z'))).toBe('2026-07-07T23:00:00.000Z');
  });

  it('sends what is due, drops nothing-to-send, keeps a failure for tomorrow', async () => {
    const rows = [
      { sessionId: 'a', settledAt: '2026-11-07T20:00:00Z' },
      { sessionId: 'b', settledAt: '2026-11-07T21:00:00Z' },
      { sessionId: 'c', settledAt: '2026-11-07T22:00:00Z' },
    ];
    const due = vi.fn((_before: string) => Promise.resolve(rows));
    const remove = vi.fn(() => Promise.resolve());
    const send = vi.fn((id: string) =>
      id === 'c' ? Promise.reject(new Error('SES down')) : Promise.resolve(id === 'a'),
    );
    const r = await runLeadEmails({
      queue: { due, remove },
      send,
      now: () => new Date('2026-11-08T09:00:00Z'),
    });
    expect(due).toHaveBeenCalledWith('2026-11-08T00:00:00.000Z');
    expect(r).toEqual({
      due: 3,
      sent: 1,
      skipped: 1,
      failed: [{ sessionId: 'c', error: 'SES down' }],
    });
    expect(
      remove.mock.calls.map((c) => (c as unknown as [{ sessionId: string }])[0].sessionId),
    ).toEqual(['a', 'b']);
  });
});
