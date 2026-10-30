import { beforeEach, describe, expect, it } from 'vitest';
import { clearPendingRead, getPendingRead, setPendingRead } from './pendingRead';

const read = { readId: 'r1', uploadId: 'u1', startedAt: 1_000 };

describe('pending read', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips', () => {
    setPendingRead(read);
    expect(getPendingRead(2_000)).toEqual(read);
  });

  it('forgets a read older than a day', () => {
    setPendingRead(read);
    expect(getPendingRead(1_000 + 24 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it('ignores junk', () => {
    window.localStorage.setItem('gdp.pendingRead', '{"readId":1}');
    expect(getPendingRead()).toBeNull();
    window.localStorage.setItem('gdp.pendingRead', 'not json');
    expect(getPendingRead()).toBeNull();
  });

  it('only clears the read it was asked to', () => {
    setPendingRead(read);
    clearPendingRead('other');
    expect(getPendingRead(2_000)).toEqual(read);
    clearPendingRead('r1');
    expect(getPendingRead(2_000)).toBeNull();
  });
});
