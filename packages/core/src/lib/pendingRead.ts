/**
 * The bill this browser is reading in the background, so the lead can leave
 * the reading screen and find it again on Bills. One at a time; a newer read
 * replaces it. Browser storage can be missing or throw (private windows), in
 * which case there's simply no row on Bills.
 */
export type PendingRead = {
  readId: string;
  uploadId: string;
  startedAt: number;
  /** Set once the read is done, so Review bill can clear it when that bill is opened. */
  billId?: string;
};

const KEY = 'gdp.pendingRead';
/** Older than this, a read is long finished and its row would only be noise. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `now` of -Infinity skips the age check. */
export function getPendingRead(now: number = Date.now()): PendingRead | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingRead>;
    if (typeof p.readId !== 'string' || typeof p.uploadId !== 'string' || typeof p.startedAt !== 'number') return null;
    return now - p.startedAt > MAX_AGE_MS ? null : (p as PendingRead);
  } catch {
    return null;
  }
}

export function setPendingRead(p: PendingRead): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* no storage: no row on Bills */
  }
}

/** Forget the pending read, but only if it's still this one (a newer read may have replaced it). */
export function clearPendingRead(readId?: string): void {
  try {
    if (readId && getPendingRead(-Infinity)?.readId !== readId) return;
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
