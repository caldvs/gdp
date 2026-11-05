import { describe, expect, it } from 'vitest';
import { IDLE_ACTIVITY_EVENTS, IDLE_MS, IDLE_WARN_MS, idleState } from './idle';

describe('idleState', () => {
  const T0 = 1_700_000_000_000;

  it('is active with nothing stored', () => {
    expect(idleState(null, T0)).toBe('active');
  });

  it('is active until two minutes before the hour', () => {
    expect(idleState(T0, T0)).toBe('active');
    expect(idleState(T0, T0 + IDLE_MS - IDLE_WARN_MS)).toBe('active');
  });

  it('warns for the last two minutes', () => {
    expect(IDLE_WARN_MS).toBe(2 * 60_000);
    expect(idleState(T0, T0 + IDLE_MS - IDLE_WARN_MS + 1)).toBe('warn');
    expect(idleState(T0, T0 + IDLE_MS)).toBe('warn');
  });

  it('expires after an hour', () => {
    expect(IDLE_MS).toBe(60 * 60_000);
    expect(idleState(T0, T0 + IDLE_MS + 1)).toBe('expired');
    expect(idleState(T0, T0 + 24 * IDLE_MS)).toBe('expired');
  });
});

it('counts focus and scrolling as activity, for screen readers', () => {
  expect(IDLE_ACTIVITY_EVENTS).toEqual(expect.arrayContaining(['focusin', 'scroll', 'pointerdown', 'keydown', 'touchstart']));
});
