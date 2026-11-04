import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  isSelfCheckEvent,
  refundRoundTrip,
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

describe('refundRoundTrip', () => {
  const fake = (over: { paymentStatus?: string; refundStatus?: string } = {}) => {
    const piCreate = vi.fn((_params: object) =>
      Promise.resolve({ id: 'pi_smoke', status: over.paymentStatus ?? 'succeeded' }),
    );
    const refundCreate = vi.fn((_params: object, _opts: object) =>
      Promise.resolve({ id: 're_smoke' }),
    );
    const refundRetrieve = vi.fn(() =>
      Promise.resolve({ id: 're_smoke', status: over.refundStatus ?? 'succeeded', amount: 200 }),
    );
    const stripe = {
      paymentIntents: { create: piCreate },
      refunds: { create: refundCreate, retrieve: refundRetrieve },
    } as unknown as Stripe;
    return { stripe, piCreate, refundCreate };
  };

  it('pays £2 with the test card and refunds it through the real refund code', async () => {
    const { stripe, piCreate, refundCreate } = fake();
    await expect(refundRoundTrip(stripe)).resolves.toMatch(/refunded re_smoke \(succeeded\)/);
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, currency: 'gbp', payment_method: 'pm_card_visa' }),
    );
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_smoke' }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^table-fee-refund-/) as string,
      }),
    );
  });

  it('fails when the payment or the refund does not go through', async () => {
    await expect(
      refundRoundTrip(fake({ paymentStatus: 'requires_action' }).stripe),
    ).rejects.toThrow(/requires_action/);
    await expect(refundRoundTrip(fake({ refundStatus: 'failed' }).stripe)).rejects.toThrow(
      /failed/,
    );
  });
});
