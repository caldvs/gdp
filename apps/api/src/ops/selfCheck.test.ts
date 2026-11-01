import { describe, it, expect } from 'vitest';
import {
  isSelfCheckEvent,
  runSelfCheck,
  stripeKeyModeProblem,
  testAccountsProblem,
} from './selfCheck.js';

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

describe('stripeKeyModeProblem', () => {
  it('needs test-mode keys outside prod', () => {
    expect(stripeKeyModeProblem('local', 'sk_test_abc')).toBeNull();
    expect(stripeKeyModeProblem('dev', 'rk_test_abc')).toBeNull();
    expect(stripeKeyModeProblem('dev', 'sk_live_abc')).toMatch(/dev must use a test-mode/);
    expect(stripeKeyModeProblem('local', 'rk_live_abc')).toMatch(/local must use a test-mode/);
  });

  it('needs live-mode keys in prod', () => {
    expect(stripeKeyModeProblem('prod', 'sk_live_abc')).toBeNull();
    expect(stripeKeyModeProblem('prod', 'rk_live_abc')).toBeNull();
    expect(stripeKeyModeProblem('prod', 'sk_test_abc')).toMatch(/prod must use a live-mode/);
  });

  it('rejects values that are not Stripe secret keys', () => {
    expect(stripeKeyModeProblem('dev', 'pk_test_abc')).toMatch(/not an sk_\/rk_ key/);
    expect(stripeKeyModeProblem('dev', '{"key":"sk_test_abc"}')).toMatch(/not an sk_\/rk_ key/);
  });
});

describe('testAccountsProblem', () => {
  it('fails only when test accounts are on in prod', () => {
    expect(testAccountsProblem('prod', 'true')).toMatch(/turn it off/);
    expect(testAccountsProblem('prod', 'false')).toBeNull();
    expect(testAccountsProblem('dev', 'true')).toBeNull();
    expect(testAccountsProblem('local', 'true')).toBeNull();
  });
});
