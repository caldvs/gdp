import { describe, it, expect } from 'vitest';
import { isSelfCheckEvent, runSelfCheck } from './selfCheck.js';

describe('isSelfCheckEvent', () => {
  it('only matches the direct-invoke payload', () => {
    expect(isSelfCheckEvent({ gdpSelfCheck: true })).toBe(true);
    expect(isSelfCheckEvent({ gdpSelfCheck: 'true' })).toBe(false);
    expect(isSelfCheckEvent({ version: '2.0', rawPath: '/healthz' })).toBe(false);
    expect(isSelfCheckEvent(null)).toBe(false);
  });
});

describe('runSelfCheck', () => {
  it('fails only when a required check fails', async () => {
    const report = await runSelfCheck([
      { name: 'a', required: true, run: () => Promise.resolve('fine') },
      { name: 'b', required: false, run: () => Promise.reject(new Error('HTTP 403')) },
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => [c.name, c.status, c.detail])).toEqual([
      ['a', 'ok', 'fine'],
      ['b', 'warn', 'HTTP 403'],
    ]);

    const failed = await runSelfCheck([
      { name: 'c', required: true, run: () => Promise.reject(new Error('AccessDenied')) },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.checks[0]).toMatchObject({ status: 'fail', detail: 'AccessDenied' });
  });
});
