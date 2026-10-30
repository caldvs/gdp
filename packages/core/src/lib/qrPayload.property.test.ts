import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildJoinUrl, decodePayoutFromQR, readPayoutFragment, MAX_LINK_TTL_MS } from './qrPayload';

const account = fc.record(
  {
    sortCode: fc.stringMatching(/^\d{6}$/),
    accountNumber: fc.stringMatching(/^\d{8}$/),
    accountHolderName: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }),
    monzoHandle: fc.stringMatching(/^[a-z0-9.]{1,20}$/),
    revolutTag: fc.stringMatching(/^[a-z0-9]{1,20}$/),
  },
  { requiredKeys: ['sortCode', 'accountNumber', 'accountHolderName'] },
);

describe('join link #p= (property)', () => {
  it('round-trips any account, including unicode names, through a full join URL', () => {
    fc.assert(
      fc.property(account, fc.stringMatching(/^[A-Z0-9]{6}$/), (acct, code) => {
        const now = 1_760_000_000_000;
        const url = new URL(buildJoinUrl('https://gdp.example/', code, acct, now));
        // Bank details only ever ride in the fragment, never the path or query.
        expect(url.search).toBe('');
        expect(url.pathname).toBe(`/join/${code}`);
        expect(url.pathname + url.search).not.toContain(acct.accountNumber);
        const decoded = decodePayoutFromQR(readPayoutFragment(url.hash), now);
        expect(decoded).toMatchObject({ ok: true, expired: false, account: acct });
      }),
    );
  });

  it('never stays valid past MAX_LINK_TTL_MS, whatever ttl is asked for', () => {
    fc.assert(
      fc.property(account, fc.integer({ min: 0, max: 10 * MAX_LINK_TTL_MS }), (acct, ttl) => {
        const now = 1_760_000_000_000;
        const p = readPayoutFragment(new URL(buildJoinUrl('https://gdp.example', 'ABC123', acct, now, ttl)).hash);
        const late = decodePayoutFromQR(p, now + MAX_LINK_TTL_MS + 1000);
        expect(late).toMatchObject({ ok: true, expired: true });
      }),
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const r = decodePayoutFromQR(junk);
        expect(typeof r.ok).toBe('boolean');
      }),
    );
  });
});
