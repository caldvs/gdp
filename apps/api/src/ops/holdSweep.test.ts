import { describe, it, expect, vi } from 'vitest';
import { isHoldSweepEvent, runHoldSweep, type HoldSweepDeps } from './holdSweep.js';
import type { TableFee } from '../services/billing/tableFee.js';
import type { PendingHold } from '../storage/tableFeeStore.js';
import type { Session } from '../types/sessions.js';

const NOW = new Date('2026-11-12T03:17:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const hold = (billId: string, heldAt: string): PendingHold => ({
  billId,
  sessionId: `s-${billId}`,
  heldAt,
});
const fee = (billId: string, over: Partial<TableFee> = {}): TableFee => ({
  billId,
  userId: 'lead',
  checkoutSessionId: `cs_${billId}`,
  paymentIntentId: `pi_${billId}`,
  kind: 'hold',
  amountPence: 100,
  paidAt: ago(7),
  sessionId: `s-${billId}`,
  ...over,
});
const session = (billId: string, status: Session['status'], guests = 1): Session =>
  ({
    sessionId: `s-${billId}`,
    billId,
    status,
    creatorUserId: 'lead',
    participants: [
      { userId: 'lead' },
      ...Array.from({ length: guests }, (_, i) => ({ userId: `g${i}` })),
    ],
  }) as unknown as Session;

const setup = (rows: { hold: PendingHold; fee: TableFee | null; session: Session | null }[]) => {
  const clear = vi.fn((_billId: string) => Promise.resolve());
  const takeFromHold = vi.fn((_s: unknown, owed: number) =>
    Promise.resolve(owed >= 30 ? ('captured' as const) : ('released' as const)),
  );
  const refundIfNobodyJoined = vi.fn((s: Session) =>
    Promise.resolve(s.participants.length > 1 ? ('guests_joined' as const) : ('released' as const)),
  );
  const deps: HoldSweepDeps = {
    holds: { list: () => Promise.resolve(rows.map((r) => r.hold)), clear },
    getFee: (billId) => Promise.resolve(rows.find((r) => r.hold.billId === billId)?.fee ?? null),
    getSession: (sessionId) =>
      Promise.resolve(rows.find((r) => r.hold.sessionId === sessionId)?.session ?? null),
    guestsFeePence: () => Promise.resolve(66),
    tableFees: { refundIfNobodyJoined, takeFromHold },
    now: () => NOW,
  };
  return { deps, clear, takeFromHold, refundIfNobodyJoined };
};

describe('isHoldSweepEvent', () => {
  it('only matches the scheduled payload', () => {
    expect(isHoldSweepEvent({ gdpHoldSweep: true })).toBe(true);
    expect(isHoldSweepEvent({ gdpHoldSweep: 'true' })).toBe(false);
    expect(isHoldSweepEvent({ version: '2.0' })).toBe(false);
    expect(isHoldSweepEvent(null)).toBe(false);
  });
});

describe('runHoldSweep (#168)', () => {
  it('takes the guests’ part from a hold on a bill still open after 6 days', async () => {
    const { deps, takeFromHold, clear } = setup([
      { hold: hold('b1', ago(6.5)), fee: fee('b1'), session: session('b1', 'claiming') },
    ]);
    const report = await runHoldSweep(deps);
    expect(report).toMatchObject({ looked: 1, captured: 1, failed: [] });
    expect(takeFromHold).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-b1' }), 66);
    expect(clear).toHaveBeenCalledWith('b1');
  });

  it('leaves a younger hold on an open bill for another day', async () => {
    const { deps, takeFromHold, clear } = setup([
      { hold: hold('b1', ago(2)), fee: fee('b1'), session: session('b1', 'claiming') },
    ]);
    expect(await runHoldSweep(deps)).toMatchObject({ waiting: 1, captured: 0 });
    expect(takeFromHold).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears holds already settled at close without calling Stripe', async () => {
    const { deps, takeFromHold, clear } = setup([
      {
        hold: hold('b1', ago(1)),
        fee: fee('b1', { capturedAt: ago(0.5), capturedPence: 50 }),
        session: null,
      },
      { hold: hold('b2', ago(1)), fee: fee('b2', { releasedAt: ago(0.5) }), session: null },
      { hold: hold('b3', ago(1)), fee: null, session: null },
    ]);
    expect(await runHoldSweep(deps)).toMatchObject({ looked: 3, alreadySettled: 3 });
    expect(takeFromHold).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(3);
  });

  it('retries a closed bill whose hold wasn’t settled, whatever its age; a binned one takes nothing', async () => {
    const { deps, takeFromHold } = setup([
      { hold: hold('b1', ago(1)), fee: fee('b1'), session: session('b1', 'settled') },
      { hold: hold('b2', ago(1)), fee: fee('b2'), session: session('b2', 'abandoned') },
    ]);
    expect(await runHoldSweep(deps)).toMatchObject({ captured: 1, released: 1 });
    expect(takeFromHold.mock.calls.map((c) => c[1])).toEqual([66, 0]);
  });

  it('releases a hold nobody joined', async () => {
    const { deps, refundIfNobodyJoined, takeFromHold } = setup([
      { hold: hold('b1', ago(7)), fee: fee('b1'), session: session('b1', 'claiming', 0) },
    ]);
    expect(await runHoldSweep(deps)).toMatchObject({ released: 1 });
    expect(refundIfNobodyJoined).toHaveBeenCalledTimes(1);
    expect(takeFromHold).not.toHaveBeenCalled();
  });

  it('takes nothing when the session has gone', async () => {
    const { deps, takeFromHold } = setup([
      { hold: hold('b1', ago(7)), fee: fee('b1'), session: null },
    ]);
    await runHoldSweep(deps);
    expect(takeFromHold.mock.calls[0]?.[1]).toBe(0);
  });

  it('carries on past a failure and reports it, keeping its row for tomorrow', async () => {
    const { deps, takeFromHold, clear } = setup([
      { hold: hold('b1', ago(7)), fee: fee('b1'), session: session('b1', 'claiming') },
      { hold: hold('b2', ago(7)), fee: fee('b2'), session: session('b2', 'claiming') },
    ]);
    takeFromHold.mockRejectedValueOnce(new Error('Stripe down'));
    const report = await runHoldSweep(deps);
    expect(report.failed).toEqual([{ billId: 'b1', error: 'Stripe down' }]);
    expect(report.captured).toBe(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith('b2');
  });
});
