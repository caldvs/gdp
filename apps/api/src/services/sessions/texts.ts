/**
 * #219/#220: the words of the texts we send guests about a bill.
 *
 * One SMS segment: at most 160 characters, all in the GSM-7 alphabet
 * (straight quotes, no emoji; `£` is in it), so each text costs one
 * message. Names, never pronouns for the lead. When a long venue or name
 * would push past 160, the venue goes first, then names are cut.
 */
export const SMS_MAX = 160;

const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Plain GSM-7: curly quotes and dashes straightened, anything else dropped. */
export function gsm7(s: string): string {
  const straight = s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ');
  return [...straight]
    .map((ch) => {
      if (GSM7.includes(ch)) return ch;
      // ë → e: the letter without its accent, when that's sendable.
      const base = ch.normalize('NFD')[0] ?? '';
      return GSM7.includes(base) ? base : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every character counts as one (no extension-table characters are let through). */
export const fitsOneSms = (s: string): boolean => s.length <= SMS_MAX && gsm7(s) === s;

export const pounds = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

/** The first word of a name, for texts: "Callum Davies" → "Callum". */
export const firstName = (name: string): string => gsm7(name).split(' ')[0] || 'Your friend';

/** "8 Dec": the day a link stops working, in London. */
export const shortDay = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });

/** Tries each wording in turn and keeps the first that fits one SMS. */
function firstFitting(candidates: string[]): string {
  for (const c of candidates) if (fitsOneSms(c)) return c;
  return candidates[candidates.length - 1]!.slice(0, SMS_MAX);
}

function names(lead: string, venue: string | undefined) {
  const l = firstName(lead);
  const v = venue ? gsm7(venue) : '';
  return { l, short: l.slice(0, 12), v, cutV: v.slice(0, 20) };
}

/** #220: the lead marked the guest's payment received. */
export function paidText(input: {
  leadName: string;
  amountPence: number;
  venueName?: string;
  link: string;
  untilEpochSeconds: number;
}): string {
  const { l, short, v, cutV } = names(input.leadName, input.venueName);
  const amount = pounds(input.amountPence);
  const tail = `See the bill: ${input.link} (until ${shortDay(input.untilEpochSeconds)})`;
  return firstFitting([
    ...(v ? [`${l} got your ${amount} for ${v}. ${tail}`] : []),
    ...(cutV ? [`${l} got your ${amount} for ${cutV}. ${tail}`] : []),
    `${l} got your ${amount}. ${tail}`,
    `${short} got your ${amount}. ${tail}`,
  ]);
}

/** #219: a reminder to a guest who hasn't paid. */
export function reminderText(input: {
  leadName: string;
  amountPence: number;
  venueName?: string;
  link: string;
  stopLink: string;
}): string {
  const { l, short, v, cutV } = names(input.leadName, input.venueName);
  const amount = pounds(input.amountPence);
  const tail = `Pay ${l} and see the bill: ${input.link} Stop reminders: ${input.stopLink}`;
  const shortTail = `Bill: ${input.link} Stop reminders: ${input.stopLink}`;
  return firstFitting([
    ...(v ? [`You owe ${l} ${amount} for ${v}. ${tail}`] : []),
    ...(cutV ? [`You owe ${l} ${amount} for ${cutV}. ${tail}`] : []),
    `You owe ${l} ${amount}. ${tail}`,
    `You owe ${short} ${amount}. ${shortTail}`,
  ]);
}
