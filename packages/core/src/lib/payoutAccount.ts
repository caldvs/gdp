// PayoutAccount lives in the lead's browser only — never on the GDP
// server. See apps/api/docs and the gdp-mobile ADRs:
//   0002-ephemeral-bank-details-via-qr.md
//   0003-client-storage-strategy.md
//
// Web: persisted in sessionStorage, so it's cleared when the tab
// closes. There's no real encryption here (ADR-0003 Phase 2 plans a
// PIN-derived WebCrypto layer). Ported from gdp-mobile minus the
// native expo-secure-store / biometric path.
export type PayoutAccount = {
  sortCode: string;
  accountNumber: string;
  accountHolderName: string;
  monzoHandle?: string;
  revolutTag?: string;
};

const STORAGE_KEY = 'gdp.payoutAccount';

// `undefined` = not read yet; `null` = read, nothing stored.
let cache: PayoutAccount | null | undefined = undefined;

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export async function readPayoutAccount(): Promise<PayoutAccount | null> {
  if (cache !== undefined) return cache;
  const raw = session()?.getItem(STORAGE_KEY) ?? null;
  cache = raw ? safeParse(raw) : null;
  return cache;
}

export async function savePayoutAccount(account: PayoutAccount): Promise<void> {
  session()?.setItem(STORAGE_KEY, JSON.stringify(account));
  cache = account;
  notify();
}

export async function clearPayoutAccount(): Promise<void> {
  session()?.removeItem(STORAGE_KEY);
  cache = null;
  notify();
}

/** For tests — forget the in-memory cache without touching storage. */
export function _resetCache(): void {
  cache = undefined;
}

function safeParse(raw: string): PayoutAccount | null {
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj.sortCode === 'string' &&
      typeof obj.accountNumber === 'string' &&
      typeof obj.accountHolderName === 'string'
    ) {
      return obj as PayoutAccount;
    }
  } catch {
    // fall through
  }
  return null;
}
