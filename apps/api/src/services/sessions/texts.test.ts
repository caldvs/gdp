import { describe, it, expect } from 'vitest';
import { firstName, fitsOneSms, gsm7, paidText, reminderText, SMS_MAX } from './texts.js';

const until = Date.UTC(2026, 11, 8, 12) / 1000;
const link = 'paymeback.dev/b/AbCdEfGhIjKlMnOp';
const stopLink = 'paymeback.dev/s/AbCdEfGhIjKlMnOp';

describe('#219/#220 texts', () => {
  it('straightens quotes and drops what GSM-7 can’t send', () => {
    expect(gsm7('Nando’s — “best” 🍗')).toBe('Nando\'s - "best"');
    expect(gsm7('Café  £12 Zoë')).toBe('Café £12 Zoe');
  });

  it('the paid text: who, how much, where, the link and its date', () => {
    const t = paidText({
      leadName: 'Callum Davies',
      amountPence: 2531,
      venueName: 'Gennaro',
      link,
      untilEpochSeconds: until,
    });
    expect(t).toBe(`Callum got your £25.31 for Gennaro. See the bill: ${link} (until 8 Dec)`);
    expect(fitsOneSms(t)).toBe(true);
  });

  it('a reminder: the amount, the bill and how to stop', () => {
    const t = reminderText({
      leadName: 'Callum',
      amountPence: 2531,
      venueName: 'Gennaro',
      link,
      stopLink,
    });
    expect(t).toBe(
      `You owe Callum £25.31 for Gennaro. Pay Callum and see the bill: ${link} Stop reminders: ${stopLink}`,
    );
    expect(fitsOneSms(t)).toBe(true);
  });

  it('a long venue or name still fits one text, dropping the venue first', () => {
    const long = 'The Very Long Name Of A Gastropub On The Corner Of Earls Court Road';
    const r = reminderText({
      leadName: 'Bartholomew-Fitzwilliam',
      amountPence: 123456,
      venueName: long,
      link: 'test.paymeback.dev/b/AbCdEfGhIjKlMnOp',
      stopLink: 'test.paymeback.dev/s/AbCdEfGhIjKlMnOp',
    });
    expect(r.length).toBeLessThanOrEqual(SMS_MAX);
    expect(fitsOneSms(r)).toBe(true);
    expect(r).toContain('Stop reminders: test.paymeback.dev/s/');
    const p = paidText({
      leadName: 'Bartholomew-Fitzwilliam Montgomery',
      amountPence: 123456,
      venueName: long,
      link: 'test.paymeback.dev/b/AbCdEfGhIjKlMnOp',
      untilEpochSeconds: until,
    });
    expect(fitsOneSms(p)).toBe(true);
    expect(p).toContain('test.paymeback.dev/b/');
  });

  it('a name with nothing GSM-7 in it still reads', () => {
    expect(firstName('🙂')).toBe('Your friend');
    expect(firstName('Zoë Smith')).toBe('Zoe');
  });
});
