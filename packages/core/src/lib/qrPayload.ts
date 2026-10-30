import type { PayoutAccount } from './payoutAccount';

// QR payload codec for peer-to-peer bank-detail exchange.
// See docs/adr/0002-ephemeral-bank-details-via-qr.md
//
// On share, the lead's app encodes their payout details + the join code
// into a single URL. The bank details ride in the URL *fragment* (the
// part after `#`), which is never sent in HTTP requests — your server
// never sees it, even when the guest opens the link.
//
//   https://gdp.app/join/ABC123#p=<base64url(JSON)>
//
// Payload shape, v1:
//   { v: 1, n: name, s: sort, a: account, m?: monzo, r?: revolut, iat: epochSecs, x?: epochSecs }
//
// A link is accepted for 10 minutes from iat — past that, the guest's
// app shows "re-scan the lead's QR" and the lead can re-show the QR to
// renew. See ADR-0004 for the rationale. That suits a QR on the lead's
// screen, which re-encodes every few minutes, but not a link pasted
// into a group chat. Shared links therefore carry an explicit expiry
// `x` (optional, so older payloads decode unchanged), capped at
// MAX_LINK_TTL_MS so a crafted payload can't live forever.

const PAYLOAD_VERSION = 1 as const;
export const PAYOUT_TTL_MS = 10 * 60 * 1000;
/** How long a copied or shared join link keeps working. */
export const SHARED_LINK_TTL_MS = 48 * 60 * 60 * 1000;
/** Upper bound on any `x`, whatever the payload claims. */
export const MAX_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PayloadV1 = {
  v: 1;
  n: string;
  s: string;
  a: string;
  m?: string;
  r?: string;
  iat: number;
  x?: number;
};

export type DecodeResult =
  | { ok: true; account: PayoutAccount; ageMs: number; expired: boolean }
  | { ok: false; reason: 'missing' | 'malformed' | 'unsupported_version' };

export function encodePayoutForQR(
  account: PayoutAccount,
  nowMs: number = Date.now(),
  ttlMs?: number,
): string {
  const payload: PayloadV1 = {
    v: PAYLOAD_VERSION,
    n: account.accountHolderName,
    s: account.sortCode,
    a: account.accountNumber,
    iat: Math.floor(nowMs / 1000),
    ...(account.monzoHandle ? { m: account.monzoHandle } : {}),
    ...(account.revolutTag ? { r: account.revolutTag } : {}),
    ...(ttlMs !== undefined ? { x: Math.floor((nowMs + Math.min(ttlMs, MAX_LINK_TTL_MS)) / 1000) } : {}),
  };
  return base64urlEncode(JSON.stringify(payload));
}

// Decode + age-check in one call. `expired` is true iff the payload is
// well-formed but past its expiry (`x` if present, capped at
// MAX_LINK_TTL_MS from iat; otherwise iat + PAYOUT_TTL_MS) — the caller can use this to
// render a "re-scan" empty state without discarding the data outright.
export function decodePayoutFromQR(
  encoded: string | null | undefined,
  nowMs: number = Date.now(),
): DecodeResult {
  if (!encoded) return { ok: false, reason: 'missing' };
  let json: string;
  try {
    json = base64urlDecode(encoded);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayloadV1(parsed)) {
    if (
      parsed &&
      typeof parsed === 'object' &&
      'v' in parsed &&
      typeof (parsed as { v: unknown }).v === 'number'
    ) {
      return { ok: false, reason: 'unsupported_version' };
    }
    return { ok: false, reason: 'malformed' };
  }
  const issuedAtMs = parsed.iat * 1000;
  const ageMs = nowMs - issuedAtMs;
  const expiresAtMs = parsed.x !== undefined
    ? Math.min(parsed.x * 1000, issuedAtMs + MAX_LINK_TTL_MS)
    : issuedAtMs + PAYOUT_TTL_MS;
  return {
    ok: true,
    ageMs,
    expired: nowMs > expiresAtMs,
    account: {
      sortCode: parsed.s,
      accountNumber: parsed.a,
      accountHolderName: parsed.n,
      ...(parsed.m ? { monzoHandle: parsed.m } : {}),
      ...(parsed.r ? { revolutTag: parsed.r } : {}),
    },
  };
}

// Builds the full join URL with the optional payout fragment. When the
// lead has no payout account on file the URL is the plain join link
// — exactly the current behaviour.
export function buildJoinUrl(
  baseUrl: string,
  joinCode: string,
  account?: PayoutAccount | null,
  nowMs?: number,
  ttlMs?: number,
): string {
  const path = `${stripTrailingSlash(baseUrl)}/join/${joinCode}`;
  if (!account) return path;
  return `${path}#p=${encodePayoutForQR(account, nowMs, ttlMs)}`;
}

// Pulls the `p=...` value out of a join URL's fragment. Returns null if
// no fragment / no `p=` param. Tolerant to additional fragment params
// the future might add.
export function readPayoutFragment(fragment: string | null | undefined): string | null {
  if (!fragment) return null;
  const cleaned = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!cleaned) return null;
  const params = new URLSearchParams(cleaned);
  return params.get('p');
}

// ─────────────────────────────────────────────────────────────────────

function isPayloadV1(value: unknown): value is PayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.n === 'string' &&
    typeof v.s === 'string' &&
    typeof v.a === 'string' &&
    typeof v.iat === 'number' &&
    (v.x === undefined || typeof v.x === 'number') &&
    (v.m === undefined || typeof v.m === 'string') &&
    (v.r === undefined || typeof v.r === 'string')
  );
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// Standard base64 (via btoa/atob) → base64url (URL-safe, no padding).
// Available in all RN runtimes (Hermes / web) since RN 0.74.
function base64urlEncode(input: string): string {
  const bytes = utf8Encode(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line no-restricted-globals
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  // eslint-disable-next-line no-restricted-globals
  const bin = atob(padded + '='.repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return utf8Decode(bytes);
}

function utf8Encode(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  // Minimal fallback for environments without TextEncoder.
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if ((c & 0xfc00) === 0xd800 && i + 1 < s.length) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xc0) {
      /* continuation, skip */
    } else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    else if (b < 0xf0) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f),
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++]! & 0x3f) << 12) |
        ((bytes[i++]! & 0x3f) << 6) |
        (bytes[i++]! & 0x3f);
      const off = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
    }
  }
  return s;
}
