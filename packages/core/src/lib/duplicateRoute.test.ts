import { describe, expect, it } from 'vitest';
import { duplicateRoute, settledSession } from './duplicateRoute';

const B = 'bill-1';
const S = 'sess-1';

describe('duplicateRoute', () => {
  it('opens Review bill for an untouched bill', () => {
    expect(duplicateRoute(B, { versionNumber: 1, amended: false })).toBe('/confirm-bill/bill-1');
  });

  it('says it picked up where they left off when the bill was amended', () => {
    expect(duplicateRoute(B, { versionNumber: 3, amended: true })).toBe('/confirm-bill/bill-1?resumed=1');
  });

  it.each(['setup', 'claiming', 'paying', 'settled'] as const)('goes to the table when the session is %s', (status) => {
    expect(duplicateRoute(B, { versionNumber: 2, amended: true, session: { sessionId: S, status } })).toBe('/session/sess-1');
  });

  it('ignores an abandoned session', () => {
    expect(duplicateRoute(B, { versionNumber: 1, amended: false, session: { sessionId: S, status: 'abandoned' } })).toBe('/confirm-bill/bill-1');
  });

  it('opens Review bill when the API sent no context', () => {
    expect(duplicateRoute(B)).toBe('/confirm-bill/bill-1');
  });
});

describe('settledSession', () => {
  it('is the session when it was settled', () => {
    expect(settledSession({ versionNumber: 1, amended: false, session: { sessionId: S, status: 'settled' } })).toBe(S);
  });

  it.each(['setup', 'claiming', 'paying', 'abandoned'] as const)('is nothing when the session is %s', (status) => {
    expect(settledSession({ versionNumber: 1, amended: false, session: { sessionId: S, status } })).toBeUndefined();
  });

  it('is nothing without a session or context', () => {
    expect(settledSession({ versionNumber: 1, amended: false })).toBeUndefined();
    expect(settledSession()).toBeUndefined();
  });
});
