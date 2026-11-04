import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  isSelfCheckEvent,
  holdRoundTrip,
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

describe('holdRoundTrip', () => {
  const fake = (over: { holdStatus?: string; afterStatus?: string } = {}) => {
    const piCreate = vi.fn((_params: object) =>
      Promise.resolve({ id: 'pi_smoke', status: over.holdStatus ?? 'requires_capture' }),
    );
    const piCancel = vi.fn((_id: string, _params: object, _opts: object) =>
      Promise.resolve({ id: 'pi_smoke', status: 'canceled' }),
    );
    const piRetrieve = vi.fn(() =>
      Promise.resolve({ id: 'pi_smoke', status: over.afterStatus ?? 'canceled' }),
    );
    const stripe = {
      paymentIntents: { create: piCreate, cancel: piCancel, retrieve: piRetrieve },
    } as unknown as Stripe;
    return { stripe, piCreate, piCancel };
  };

  it('holds £1 with the test card and releases it through the real release code', async () => {
    const { stripe, piCreate, piCancel } = fake();
    await expect(holdRoundTrip(stripe)).resolves.toMatch(/held pi_smoke £1.00, released/);
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        currency: 'gbp',
        capture_method: 'manual',
        payment_method: 'pm_card_visa',
      }),
    );
    expect(piCancel).toHaveBeenCalledWith(
      'pi_smoke',
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^table-fee-release-/) as string,
      }),
    );
  });

  it('fails when the hold or the release does not go through', async () => {
    await expect(holdRoundTrip(fake({ holdStatus: 'requires_action' }).stripe)).rejects.toThrow(
      /requires_action/,
    );
    await expect(holdRoundTrip(fake({ afterStatus: 'requires_capture' }).stripe)).rejects.toThrow(
      /not canceled/,
    );
  });
});
