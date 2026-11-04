const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address a sign-in link's sending limits are counted against (#146).
 * Lower case, without a `+tag`, and for Gmail without dots, so
 * `Sam.Smith+1@gmail.com` and `samsmith+2@googlemail.com` share one
 * allowance. Used for the limit only: the link still goes to, and signs in,
 * the address as typed.
 */
export function rateKeyForEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  local = local.split('+')[0] || local;
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}
