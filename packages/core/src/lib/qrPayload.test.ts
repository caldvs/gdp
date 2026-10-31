import { describe, it, expect } from 'vitest';
import type { PayoutAccount } from './payoutAccount';
import {
  buildJoinUrl,
  decodePayoutFromQR,
  encodePayoutForQR,
  MAX_LINK_TTL_MS,
  PAYOUT_TTL_MS,
  SHARED_LINK_TTL_MS,
  readPayoutFragment,
} from './qrPayload';

const sample: PayoutAccount = {
  sortCode: '040668',
  accountNumber: '00079660',
  accountHolderName: 'Alice Cooper',
};

const withHandles: PayoutAccount = {
  ...sample,
  monzoHandle: 'alice.cooper',
  revolutTag: 'alicec',
};

describe('encodePayoutForQR / decodePayoutFromQR', () => {
  it('round-trips a minimal account', () => {
    const now = 1715430000000;
    const encoded = encodePayoutForQR(sample, now);
    const decoded = decodePayoutFromQR(encoded, now);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.account).toEqual(sample);
    expect(decoded.expired).toBe(false);
    expect(decoded.ageMs).toBe(0);
  });

  it('round-trips Monzo + Revolut handles', () => {
    const now = 1715430000000;
    const encoded = encodePayoutForQR(withHandles, now);
    const decoded = decodePayoutFromQR(encoded, now);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.account).toEqual(withHandles);
  });

  it('flags expired payloads but still returns the account', () => {
    const issuedAt = 1715430000000;
    const encoded = encodePayoutForQR(sample, issuedAt);
    const decoded = decodePayoutFromQR(encoded, issuedAt + PAYOUT_TTL_MS + 1);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.expired).toBe(true);
    expect(decoded.account).toEqual(sample);
  });

  it('returns malformed for nonsense', () => {
    expect(decodePayoutFromQR('not-base64').ok).toBe(false);
    expect(decodePayoutFromQR(null).ok).toBe(false);
    expect(decodePayoutFromQR('').ok).toBe(false);
  });

  it('returns unsupported_version for a future v', () => {
    // Hand-roll a v=999 payload.
    const payload = JSON.stringify({
      v: 999,
      n: 'x',
      s: '040668',
      a: '00079660',
      iat: Math.floor(Date.now() / 1000),
    });
    // Reproduce base64url encoding inline so we don't depend on the
    // module's private helper.
    const b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = decodePayoutFromQR(b64);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unsupported_version');
  });
});

describe('shared-link expiry (x)', () => {
  const ACCOUNT = { accountHolderName: 'Alice Cooper', sortCode: '040668', accountNumber: '00079660' };
  const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

  it('a QR payload (no ttl) still expires after 10 minutes', () => {
    const enc = encodePayoutForQR(ACCOUNT, T0);
    expect(decodePayoutFromQR(enc, T0 + 9 * 60_000)).toMatchObject({ ok: true, expired: false });
    expect(decodePayoutFromQR(enc, T0 + 11 * 60_000)).toMatchObject({ ok: true, expired: true });
  });

  it('a shared link works for SHARED_LINK_TTL_MS', () => {
    const enc = encodePayoutForQR(ACCOUNT, T0, SHARED_LINK_TTL_MS);
    expect(decodePayoutFromQR(enc, T0 + 6 * 3600_000)).toMatchObject({ ok: true, expired: false });
    expect(decodePayoutFromQR(enc, T0 + SHARED_LINK_TTL_MS - 60_000)).toMatchObject({ ok: true, expired: false });
    expect(decodePayoutFromQR(enc, T0 + SHARED_LINK_TTL_MS + 60_000)).toMatchObject({ ok: true, expired: true });
  });

  it('caps a requested ttl at MAX_LINK_TTL_MS', () => {
    const enc = encodePayoutForQR(ACCOUNT, T0, 365 * 24 * 3600_000);
    expect(decodePayoutFromQR(enc, T0 + MAX_LINK_TTL_MS + 60_000)).toMatchObject({ ok: true, expired: true });
  });

  it('caps a crafted far-future x at MAX_LINK_TTL_MS from iat', () => {
    const crafted = { v: 1, n: 'Mallory', s: '040668', a: '00079660', iat: Math.floor(T0 / 1000), x: Math.floor(T0 / 1000) + 10 * 365 * 24 * 3600 };
    const enc = Buffer.from(JSON.stringify(crafted)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodePayoutFromQR(enc, T0 + MAX_LINK_TTL_MS + 60_000)).toMatchObject({ ok: true, expired: true });
  });

  it('buildJoinUrl passes the ttl through', () => {
    const url = buildJoinUrl('https://gdp.app', 'ABC123', ACCOUNT, T0, SHARED_LINK_TTL_MS);
    const frag = readPayoutFragment(url.slice(url.indexOf('#')));
    expect(decodePayoutFromQR(frag, T0 + 24 * 3600_000)).toMatchObject({ ok: true, expired: false });
  });
});

describe('buildJoinUrl', () => {
  it('returns the plain join path when no account', () => {
    expect(buildJoinUrl('https://gdp.app', 'ABC123')).toBe('https://gdp.app/join/ABC123');
    expect(buildJoinUrl('https://gdp.app/', 'ABC123', null)).toBe(
      'https://gdp.app/join/ABC123',
    );
  });

  it('appends an #p= fragment when account is provided', () => {
    const url = buildJoinUrl('https://gdp.app', 'ABC123', sample, 1715430000000);
    expect(url.startsWith('https://gdp.app/join/ABC123#p=')).toBe(true);
    const encoded = readPayoutFragment(url.slice(url.indexOf('#')));
    expect(encoded).not.toBeNull();
    const decoded = decodePayoutFromQR(encoded!, 1715430000000);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.account).toEqual(sample);
  });
});

describe('readPayoutFragment', () => {
  it('pulls the p value out of a fragment', () => {
    expect(readPayoutFragment('#p=abc')).toBe('abc');
    expect(readPayoutFragment('#p=abc&other=1')).toBe('abc');
    expect(readPayoutFragment('p=abc')).toBe('abc');
  });

  it('returns null for fragments without p', () => {
    expect(readPayoutFragment(null)).toBeNull();
    expect(readPayoutFragment('')).toBeNull();
    expect(readPayoutFragment('#')).toBeNull();
    expect(readPayoutFragment('#other=1')).toBeNull();
  });
});
