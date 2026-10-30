import type { PayoutAccount } from './payoutAccount';
import { decodePayoutFromQR, readPayoutFragment } from './qrPayload';

// Guest-side store for a lead's bank details, scoped per session.
// See ADR-0002 + ADR-0004.
//
// The 10-minute TTL in the QR payload decides whether a scanned or
// tapped link is *accepted*. Once accepted, the details are kept on this
// device until the guest has paid (callers clear them) or for
// GUEST_KEEP_MS, whichever comes first. Many guests pay later from
// home; dropping the details after 10 minutes, or when the tab closes,
// left them with "ask the host to show the QR again".
//
// On web: localStorage. Elsewhere: an in-memory Map.

/** How long accepted details stay on the guest's device at most. */
export const GUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const memoryStore = new Map<string, string>();

function storageKey(sessionId: string): string {
  return `gdp.sessionPayout.${sessionId}`;
}

function local(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getRaw(sessionId: string): string | null {
  const key = storageKey(sessionId);
  const ls = local();
  return ls ? ls.getItem(key) : memoryStore.get(key) ?? null;
}

function setRaw(sessionId: string, value: string): void {
  const key = storageKey(sessionId);
  const ls = local();
  if (ls) ls.setItem(key, value);
  else memoryStore.set(key, value);
}

function clearRaw(sessionId: string): void {
  const key = storageKey(sessionId);
  const ls = local();
  if (ls) ls.removeItem(key);
  else memoryStore.delete(key);
  // Entries written before this moved to localStorage.
  try {
    if (typeof window !== 'undefined') window.sessionStorage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

// The encoded fragment is kept as-is so it decodes the same way it was
// accepted; storedAt starts the keep-on-device clock.
type StoredShape = {
  encoded: string;
  storedAt: number;
};

export function storeSessionPayoutFromFragment(
  sessionId: string,
  fragment: string | null,
  nowMs: number = Date.now(),
): { stored: PayoutAccount | null; reason?: string } {
  const encoded = readPayoutFragment(fragment);
  if (!encoded) return { stored: null };
  const decoded = decodePayoutFromQR(encoded, nowMs);
  if (!decoded.ok) {
    return { stored: null, reason: decoded.reason };
  }
  if (decoded.expired) {
    return { stored: null, reason: 'expired' };
  }
  const value: StoredShape = { encoded, storedAt: nowMs };
  setRaw(sessionId, JSON.stringify(value));
  return { stored: decoded.account };
}

// Returns null if nothing is stored, or if the entry is past
// GUEST_KEEP_MS (in which case it's also cleared).
export function readSessionPayout(sessionId: string, nowMs: number = Date.now()): PayoutAccount | null {
  const raw = getRaw(sessionId);
  if (!raw) return null;
  let stored: Partial<StoredShape>;
  try {
    stored = JSON.parse(raw);
  } catch {
    clearRaw(sessionId);
    return null;
  }
  const decoded = decodePayoutFromQR(stored.encoded, nowMs);
  if (!decoded.ok || typeof stored.storedAt !== 'number' || nowMs - stored.storedAt > GUEST_KEEP_MS) {
    clearRaw(sessionId);
    return null;
  }
  return decoded.account;
}

export function clearSessionPayout(sessionId: string): void {
  clearRaw(sessionId);
}

// Browser hygiene: remove the `#p=` fragment from the URL bar so the
// bank details don't sit in the visible address. Note that browsers
// may still retain the original URL in history (back-button history
// retains pre-replaceState URLs); we accept that trade-off.
export function scrubFragmentFromUrl(): void {
  if (typeof window === 'undefined') return;
  if (!window.location?.hash) return;
  if (typeof window.history?.replaceState !== 'function') return;
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );
}
