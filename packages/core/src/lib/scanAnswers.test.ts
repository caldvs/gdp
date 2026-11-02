import { beforeEach, describe, expect, it } from 'vitest';
import { answersForBill, answersForUpload, attachAnswersToBill, saveAnswers, spendAnswer } from './scanAnswers';

describe('scan answers (#61)', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps answers per upload, then per bill', () => {
    saveAnswers('up1', { venue: { name: ' Ad Maiora ', placeId: 'p1', address: '84 Tib St' } });
    saveAnswers('up1', { expectedDiners: 4 });
    expect(answersForUpload('up1')).toMatchObject({ venue: { name: 'Ad Maiora', placeId: 'p1' }, expectedDiners: 4 });
    expect(answersForBill('b1')).toBeNull();
    attachAnswersToBill('up1', 'b1');
    expect(answersForBill('b1')).toMatchObject({ uploadId: 'up1', expectedDiners: 4 });
  });

  it('clears an answer set back to nothing', () => {
    saveAnswers('up1', { venue: { name: 'X' }, expectedDiners: 3 });
    saveAnswers('up1', { venue: { name: '  ' }, expectedDiners: null });
    const a = answersForUpload('up1');
    expect(a?.venue).toBeUndefined();
    expect(a?.expectedDiners).toBeUndefined();
  });

  it('a new read replaces an older read’s answers', () => {
    saveAnswers('up1', { expectedDiners: 3 });
    saveAnswers('up2', { expectedDiners: 5 });
    expect(answersForUpload('up1')).toBeNull();
    expect(answersForUpload('up2')?.expectedDiners).toBe(5);
  });

  it('each answer is used once', () => {
    saveAnswers('up1', { venue: { name: 'X' }, expectedDiners: 3 });
    attachAnswersToBill('up1', 'b1');
    spendAnswer('b1', 'venue');
    expect(answersForBill('b1')).toMatchObject({ expectedDiners: 3 });
    expect(answersForBill('b1')?.venue).toBeUndefined();
    spendAnswer('b1', 'expectedDiners');
    expect(answersForBill('b1')).toBeNull();
  });

  it('ignores answers older than a day', () => {
    window.localStorage.setItem('gdp.scanAnswers', JSON.stringify({ uploadId: 'up1', at: Date.now() - 25 * 3600_000, expectedDiners: 3 }));
    expect(answersForUpload('up1')).toBeNull();
  });
});
