import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  isSelfCheckEvent,
  holdRoundTrip,
  savedCardRoundTrip,
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
    // The first retrieve checks the released hold; the second the captured one.
    const piRetrieve = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pi_smoke', status: over.afterStatus ?? 'canceled' })
      .mockResolvedValue({ id: 'pi_smoke', status: 'succeeded', amount_received: 66 });
    const piCapture = vi.fn((_id: string, _p: object, _o: object) =>
      Promise.resolve({ id: 'pi_smoke', status: 'succeeded' }),
    );
    const stripe = {
      paymentIntents: {
        create: piCreate,
        cancel: piCancel,
        retrieve: piRetrieve,
        capture: piCapture,
      },
    } as unknown as Stripe;
    return { stripe, piCreate, piCancel, piCapture };
  };

  it('holds £1 with the test card and releases it through the real release code', async () => {
    const { stripe, piCreate, piCancel, piCapture } = fake();
    await expect(holdRoundTrip(stripe)).resolves.toMatch(
      /released; held pi_smoke £1.00, took £0.66/,
    );
    expect(piCapture).toHaveBeenCalledWith(
      'pi_smoke',
      { amount_to_capture: 66 },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^table-fee-capture-/) as string,
      }),
    );
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

describe('savedCardRoundTrip (#228)', () => {
  const fake = (over: { chargeError?: boolean } = {}) => {
    let creates = 0;
    const piCreate = vi.fn(
      (params: { amount: number; off_session?: boolean; payment_method?: string }) => {
        creates += 1;
        if (params.off_session && params.payment_method === 'pm_3ds' && !over.chargeError) {
          return Promise.reject(
            Object.assign(new Error('Authentication required'), {
              type: 'StripeCardError',
              code: 'authentication_required',
              payment_intent: { id: 'pi_ask' },
            }),
          );
        }
        if (params.off_session) {
          return Promise.resolve({
            id: 'pi_charge',
            status: 'succeeded',
            amount_received: params.amount,
          });
        }
        return Promise.resolve({
          id: `pi_hold${creates}`,
          status: 'requires_capture',
          payment_method: 'pm_saved',
        });
      },
    );
    const piRetrieve = vi.fn((id: string) =>
      Promise.resolve(
        id === 'pi_charge'
          ? { id, status: 'succeeded', amount_received: 184 }
          : { id, status: 'canceled' },
      ),
    );
    const stripe = {
      customers: {
        create: vi.fn(() => Promise.resolve({ id: 'cus_smoke' })),
        del: vi.fn(() => Promise.resolve({})),
      },
      paymentMethods: { attach: vi.fn(() => Promise.resolve({ id: 'pm_3ds' })) },
      paymentIntents: {
        create: piCreate,
        cancel: vi.fn(() => Promise.resolve({ status: 'canceled' })),
        retrieve: piRetrieve,
      },
    } as unknown as Stripe;
    return { stripe, piCreate };
  };

  it('saves the card, releases the hold, charges £1.84 off-session, and a 3D Secure card needs confirming', async () => {
    const { stripe, piCreate } = fake();
    await expect(savedCardRoundTrip(stripe)).resolves.toMatch(
      /hold released, charged £1.84 \(pi_charge\); 3D Secure card needs confirming/,
    );
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ setup_future_usage: 'off_session', customer: 'cus_smoke' }),
    );
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 184, off_session: true, payment_method: 'pm_saved' }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^table-fee-charge-smoke-/) as string,
      }),
    );
  });

  it('fails when the 3D Secure card is charged without asking', async () => {
    await expect(savedCardRoundTrip(fake({ chargeError: true }).stripe)).rejects.toThrow(
      /not needs_confirming/,
    );
  });
});
