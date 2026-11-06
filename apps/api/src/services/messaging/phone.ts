/**
 * Phone numbers as E.164 (`+447700900123`). WhatsApp sends and expects the
 * digits without the `+`.
 */
export const toE164 = (waId: string): string => `+${waId.replace(/\D/g, '')}`;
export const toWaId = (e164: string): string => e164.replace(/\D/g, '');

/** For logs: never a whole number. `+44•••••••123`. */
export const maskPhone = (phone: string): string => {
  const d = phone.replace(/\D/g, '');
  if (d.length <= 5) return '•••';
  return `+${d.slice(0, 2)}${'•'.repeat(d.length - 5)}${d.slice(-3)}`;
};

/**
 * #213: a UK mobile number as typed (`07700 900123`, `7700900123`,
 * `+44 7700 900123`, `0044…`) to E.164, or null if it isn't one. UK
 * mobiles only for now: +44 7, then 9 digits.
 */
export function parseUkMobile(input: string): string | null {
  let d = input.replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith('44')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return /^7\d{9}$/.test(d) ? `+44${d}` : null;
}

/** `+447700900123` → `+44 7700 900123`, for the person's own screen only. */
export const formatUkMobile = (e164: string): string =>
  e164.startsWith('+44') && e164.length === 13 ? `+44 ${e164.slice(3, 7)} ${e164.slice(7)}` : e164;
