/**
 * The reference a guest puts on their bank transfer (#222): the venue and
 * their first name ("Gennaro Tom"), so the lead can tell who paid from their
 * statement. UK Faster Payments carry 18 characters; banks differ on
 * punctuation, so only letters, digits and spaces are kept. The name always
 * fits; the venue keeps the whole words that fit.
 */
export const REFERENCE_MAX = 18;

function clean(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function paymentReference(venue: string | undefined, guestName: string | undefined): string {
  const name = clean(guestName).split(' ')[0]?.slice(0, REFERENCE_MAX) ?? '';
  const room = REFERENCE_MAX - name.length - (name ? 1 : 0);
  // Whole words of the venue, as many as fit.
  let place = '';
  for (const w of clean(venue).replace(/^the /i, '').split(' ')) {
    const next = place ? `${place} ${w}` : w;
    if (next.length > room) break;
    place = next;
  }
  const ref = [place, name].filter(Boolean).join(' ');
  return ref || 'Pay Me Back';
}
