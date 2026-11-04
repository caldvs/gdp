import { describe, expect, it } from 'vitest';
import { checkPayout, payoutCheckFor } from './payoutCheck';

const lead = { sortCode: '040668', accountNumber: '00079660', accountHolderName: 'Callum Davies' };
const SID = '0190f1d2-0000-7000-8000-000000000001';

describe('payoutCheck (#151)', () => {
  it('is 64 hex characters and stable', async () => {
    const a = await payoutCheckFor(SID, lead);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await payoutCheckFor(SID, { ...lead })).toBe(a);
  });

  it('changes with the session and with every detail a guest pays by', async () => {
    const a = await payoutCheckFor(SID, lead);
    expect(await payoutCheckFor(SID.replace(/1$/, '2'), lead)).not.toBe(a);
    expect(await payoutCheckFor(SID, { ...lead, accountNumber: '12345678' })).not.toBe(a);
    expect(await payoutCheckFor(SID, { ...lead, sortCode: '200000' })).not.toBe(a);
    expect(await payoutCheckFor(SID, { ...lead, accountHolderName: 'Someone Else' })).not.toBe(a);
    expect(await payoutCheckFor(SID, { ...lead, monzoHandle: 'thief' })).not.toBe(a);
    expect(await payoutCheckFor(SID, { ...lead, revolutTag: 'thief' })).not.toBe(a);
  });

  it('does not contain the details', async () => {
    const a = (await payoutCheckFor(SID, lead))!;
    expect(a).not.toContain(lead.accountNumber);
    expect(a).not.toContain(lead.sortCode);
  });

  it('checkPayout: match, mismatch, or unchecked with nothing to compare', async () => {
    const expected = (await payoutCheckFor(SID, lead))!;
    expect(await checkPayout(SID, lead, expected)).toBe('match');
    expect(await checkPayout(SID, { ...lead, accountNumber: '12345678' }, expected)).toBe(
      'mismatch',
    );
    expect(await checkPayout(SID, lead, undefined)).toBe('unchecked');
  });
});
