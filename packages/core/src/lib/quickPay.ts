// One-tap payment links for the lead's Monzo / Revolut handles, which
// travel in the join QR alongside the bank details (ADR-0002).
//
// Monzo: monzo.me/<handle>/<amount>?d=<note> opens the payment with the
// amount and note filled in. Revolut has no documented amount parameter
// for revolut.me, so that link opens the profile and the guest types the
// amount.

/** Strips what people paste around a handle: "@", "monzo.me/", a full URL. */
export function cleanHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(monzo|revolut)\.me\//i, '')
    .replace(/^@/, '')
    .split(/[/?#\s]/)[0] ?? '';
}

export function monzoPayUrl(handle: string, amountPence?: number, note?: string): string | null {
  const h = cleanHandle(handle);
  if (!h) return null;
  const base = `https://monzo.me/${encodeURIComponent(h)}`;
  if (amountPence === undefined || amountPence <= 0) return base;
  const amount = (amountPence / 100).toFixed(2);
  return `${base}/${amount}${note ? `?d=${encodeURIComponent(note)}` : ''}`;
}

export function revolutPayUrl(tag: string): string | null {
  const t = cleanHandle(tag);
  return t ? `https://revolut.me/${encodeURIComponent(t)}` : null;
}
