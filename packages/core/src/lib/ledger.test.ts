import { describe, expect, it } from 'vitest';
import type { components } from '../api';
import { ledger } from './ledger';

type Participant = components['schemas']['Participant'];
const guest = (over: Partial<Participant>): Participant => ({
  userId: 'u', displayName: 'Bob', claimedItemIds: [], sharedItemIds: [], readyToLock: false, payment: { status: 'unpaid' }, ...over,
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ledger (#121)', () => {
  it('nothing paid: all of it is due', () => {
    expect(ledger(guest({}), 1450)).toMatchObject({ sentPence: 0, duePence: 1450, settled: false });
  });

  it('a payment opened but not sent is a draft, not sent', () => {
    const l = ledger(guest({ payments: [{ paymentId: id(1), amountPence: 1450, status: 'pending' }] }), 1450);
    expect(l).toMatchObject({ sentPence: 0, duePence: 1450, waiting: [] });
    expect(l.draft?.paymentId).toBe(id(1));
  });

  it('paid, then claimed more: the difference is due and it isn’t settled', () => {
    const l = ledger(guest({ payments: [{ paymentId: id(1), amountPence: 1450, status: 'succeeded' }] }), 2200);
    expect(l).toMatchObject({ sentPence: 1450, confirmedPence: 1450, duePence: 750, settled: false });
  });

  it('settled only when nothing is due and every payment is confirmed', () => {
    const entries = [
      { paymentId: id(1), amountPence: 1450, status: 'succeeded' as const },
      { paymentId: id(2), amountPence: 750, status: 'pending' as const, payerClaimedPaidAt: '2026-11-02T12:00:00.000Z' },
    ];
    const waiting = ledger(guest({ payments: entries }), 2200);
    expect(waiting).toMatchObject({ duePence: 0, settled: false });
    expect(waiting.waiting.map((e) => e.paymentId)).toEqual([id(2)]);
    expect(ledger(guest({ payments: entries.map((e) => ({ ...e, status: 'succeeded' as const })) }), 2200).settled).toBe(true);
  });

  it('failed payments don’t count', () => {
    expect(ledger(guest({ payments: [{ paymentId: id(1), amountPence: 1450, status: 'failed' }] }), 1450).duePence).toBe(1450);
  });

  it('sessions from before top-ups read their one payment as what they owed', () => {
    expect(ledger(guest({ payment: { status: 'succeeded', paymentId: id(1), paidAt: '2026-11-01T12:00:00.000Z' } }), 1450)).toMatchObject({ confirmedPence: 1450, settled: true });
  });
});
