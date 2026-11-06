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
