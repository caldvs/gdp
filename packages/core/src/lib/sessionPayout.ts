import type { PayoutAccount } from './payoutAccount';
import { decodePayoutFromQR, readPayoutFragment } from './qrPayload';

// Guest-side temporary store for a lead's bank details, scoped per
// session. Lives in sessionStorage (cleared when the tab closes on web;
// equivalent ephemeral lifetime on native via JS memory + AsyncStorage
// would *not* be appropriate — keep it in JS module memory there). See
// ADR-0002 + ADR-0004.

// On web: sessionStorage. On native: an in-memory Map. Either way it's
// gone when the app is killed.
const memoryStore = new Map<string, string>();

function storageKey(sessionId: string): string {
  return `gdp.sessionPayout.${sessionId}`;
}

function getRaw(sessionId: string): string | null {
  const key = storageKey(sessionId);
  if (typeof window !== 'undefined' && window.sessionStorage) {
    return window.sessionStorage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
}

function setRaw(sessionId: string, value: string): void {
  const key = storageKey(sessionId);
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.setItem(key, value);
    return;
  }
  memoryStore.set(key, value);
}

function clearRaw(sessionId: string): void {
  const key = storageKey(sessionId);
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.removeItem(key);
    return;
  }
  memoryStore.delete(key);
}

// Stored alongside the account is the encoded fragment string we'll
// re-evaluate the TTL against on each read. The TTL clock starts from
// the lead's encode time (iat in the payload), not our store time, so
// late-stored fragments expire correctly.
type StoredShape = {
  encoded: string;
};

export function storeSessionPayoutFromFragment(
  sessionId: string,
  fragment: string | null,
): { stored: PayoutAccount | null; reason?: string } {
  const encoded = readPayoutFragment(fragment);
  if (!encoded) return { stored: null };
  const decoded = decodePayoutFromQR(encoded);
  if (!decoded.ok) {
    return { stored: null, reason: decoded.reason };
  }
  if (decoded.expired) {
    return { stored: null, reason: 'expired' };
  }
  const value: StoredShape = { encoded };
  setRaw(sessionId, JSON.stringify(value));
  return { stored: decoded.account };
}

// Read + re-evaluate TTL. Returns null if not stored, or if the stored
// payload is now expired (in which case we also clear it).
export function readSessionPayout(sessionId: string): PayoutAccount | null {
  const raw = getRaw(sessionId);
  if (!raw) return null;
  let stored: StoredShape;
  try {
    stored = JSON.parse(raw);
  } catch {
    clearRaw(sessionId);
    return null;
  }
  const decoded = decodePayoutFromQR(stored.encoded);
  if (!decoded.ok) {
    clearRaw(sessionId);
    return null;
  }
  if (decoded.expired) {
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
