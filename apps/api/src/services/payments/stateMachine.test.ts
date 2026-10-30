import { describe, it, expect } from 'vitest';
import { nextStatus, isAlreadyApplied } from './stateMachine.js';

describe('nextStatus', () => {
  it('pending → authorized on authorized', () => {
    expect(nextStatus('pending', 'authorized')).toBe('authorized');
  });

  it('pending → failed on failed', () => {
    expect(nextStatus('pending', 'failed')).toBe('failed');
  });

  it('authorized → succeeded on executed or settled', () => {
    expect(nextStatus('authorized', 'executed')).toBe('succeeded');
    expect(nextStatus('authorized', 'settled')).toBe('succeeded');
  });

  it('authorized → failed on failed', () => {
    expect(nextStatus('authorized', 'failed')).toBe('failed');
  });

  it('succeeded → refunded on refunded', () => {
    expect(nextStatus('succeeded', 'refunded')).toBe('refunded');
  });

  it('returns null for invalid transitions', () => {
    expect(nextStatus('succeeded', 'authorized')).toBeNull();
    expect(nextStatus('failed', 'executed')).toBeNull();
    expect(nextStatus('refunded', 'failed')).toBeNull();
    expect(nextStatus('pending', 'executed')).toBeNull();
    expect(nextStatus('pending', 'settled')).toBeNull();
  });
});

describe('isAlreadyApplied', () => {
  it('detects redundant repeat events', () => {
    expect(isAlreadyApplied('authorized', 'authorized')).toBe(true);
    expect(isAlreadyApplied('succeeded', 'executed')).toBe(true);
    expect(isAlreadyApplied('succeeded', 'settled')).toBe(true);
    expect(isAlreadyApplied('failed', 'failed')).toBe(true);
    expect(isAlreadyApplied('refunded', 'refunded')).toBe(true);
  });

  it('returns false for first-time applications', () => {
    expect(isAlreadyApplied('pending', 'authorized')).toBe(false);
    expect(isAlreadyApplied('authorized', 'executed')).toBe(false);
  });
});
