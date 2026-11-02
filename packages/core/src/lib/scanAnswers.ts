/**
 * What the lead said while the bill was read (#61): where they are and how
 * many are eating. Kept in this browser from the moment they answer, keyed
 * by the upload (a retried read keeps the same upload, so the answers
 * survive it), then by the bill once it's read. Each answer is used once:
 * the venue when Review bill opens, the party size when the table is made.
 * Browser storage can be missing or throw (private windows): then the
 * answers just aren't kept.
 */
export type ScanVenue = { name: string; placeId?: string; address?: string };
export type ScanAnswers = {
  uploadId: string;
  billId?: string;
  venue?: ScanVenue;
  expectedDiners?: number;
  at: number;
};

const KEY = 'gdp.scanAnswers';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function read(now = Date.now()): ScanAnswers | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<ScanAnswers>;
    if (typeof a.uploadId !== 'string' || typeof a.at !== 'number') return null;
    return now - a.at > MAX_AGE_MS ? null : (a as ScanAnswers);
  } catch {
    return null;
  }
}

function write(a: ScanAnswers | null): void {
  try {
    if (a) window.localStorage.setItem(KEY, JSON.stringify(a));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* no storage: answers aren't kept */
  }
}

/** The answers given for this upload's read, if any. */
export function answersForUpload(uploadId: string): ScanAnswers | null {
  const a = read();
  return a?.uploadId === uploadId ? a : null;
}

/** The answers given while this bill was read, if any. */
export function answersForBill(billId: string): ScanAnswers | null {
  const a = read();
  return a?.billId === billId ? a : null;
}

/** Save the answers for a read in progress (replaces any older read's). */
export function saveAnswers(uploadId: string, patch: { venue?: ScanVenue | null; expectedDiners?: number | null }): void {
  const prev = answersForUpload(uploadId);
  const next: ScanAnswers = { ...(prev ?? { uploadId }), at: Date.now() };
  if (patch.venue !== undefined) {
    if (patch.venue && patch.venue.name.trim()) next.venue = { ...patch.venue, name: patch.venue.name.trim() };
    else delete next.venue;
  }
  if (patch.expectedDiners !== undefined) {
    if (patch.expectedDiners === null) delete next.expectedDiners;
    else next.expectedDiners = patch.expectedDiners;
  }
  write(next);
}

/** The read finished: from now on the answers belong to its bill. */
export function attachAnswersToBill(uploadId: string, billId: string): void {
  const a = answersForUpload(uploadId);
  if (a && a.billId !== billId) write({ ...a, billId });
}

/** One answer has been used; forget it so it's never sent twice. */
export function spendAnswer(billId: string, which: 'venue' | 'expectedDiners'): void {
  const a = answersForBill(billId);
  if (!a) return;
  const next = { ...a };
  delete next[which];
  write(next.venue || next.expectedDiners !== undefined ? next : null);
}
