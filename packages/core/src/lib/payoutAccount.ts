// PayoutAccount lives in the lead's browser only — never on the GDP
// server. See apps/api/docs and the gdp-mobile ADRs:
//   0002-ephemeral-bank-details-via-qr.md
//   0003-client-storage-strategy.md
//
// Web: sessionStorage by default, so it's cleared when the tab closes.
// The lead can opt in to "Remember on this device", which keeps it in
// localStorage instead (still this browser only, never our server).
// There's no real encryption here (ADR-0003 Phase 2 plans a
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

function device(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export async function readPayoutAccount(): Promise<PayoutAccount | null> {
  if (cache !== undefined) return cache;
  const raw = session()?.getItem(STORAGE_KEY) ?? device()?.getItem(STORAGE_KEY) ?? null;
  cache = raw ? safeParse(raw) : null;
  return cache;
}

/** True when the details are kept on this device beyond the tab. */
export function isPayoutAccountRemembered(): boolean {
  return device()?.getItem(STORAGE_KEY) != null;
}

export async function savePayoutAccount(
  account: PayoutAccount,
  opts: { remember?: boolean } = {},
): Promise<void> {
  const value = JSON.stringify(account);
  if (opts.remember) {
    device()?.setItem(STORAGE_KEY, value);
    session()?.removeItem(STORAGE_KEY);
  } else {
    session()?.setItem(STORAGE_KEY, value);
    device()?.removeItem(STORAGE_KEY);
  }
  cache = account;
  notify();
}

export async function clearPayoutAccount(): Promise<void> {
  session()?.removeItem(STORAGE_KEY);
  device()?.removeItem(STORAGE_KEY);
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
