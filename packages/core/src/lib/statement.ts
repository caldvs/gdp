import type { components } from '../api';
import { ledger } from './ledger';
import { formatGBP } from './money';
import { projectFeePence, projectOwedPence, sharePence, splitPricePence } from './owed';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];

/**
 * The lead's bill summary (#131, board L6): a plain statement like the
 * emailed report. Everything here is worked out from the session and bill
 * the screens already have.
 */
export type StatementLine = { label: string; pence: number };

export type PersonStatus = 'lead' | 'paid' | 'says-paid' | 'part-paid' | 'not-paid';

export type PersonStatement = {
  userId: string;
  name: string;
  status: PersonStatus;
  items: StatementLine[];
  /** Service and tax on their items. */
  extrasPence: number;
  /** Their round-up to the next whole pound on a hold; 0 for the lead. */
  feePence: number;
  totalPence: number;
};

export type PaymentLine = {
  name: string;
  /** When it was confirmed, else when they said they'd sent it. */
  at?: string;
  confirmed: boolean;
  amountPence: number;
};

export type Statement = {
  itemsPence: number;
  extrasPence: number;
  totalPence: number;
  people: PersonStatement[];
  /** What nobody claimed: it goes on the lead. Empty when everything is. */
  unclaimed: { items: StatementLine[]; extrasPence: number; totalPence: number };
  payments: PaymentLine[];
  /** Guests who haven't paid yet, and what they owe. */
  unpaid: { name: string; pence: number }[];
  receivedPence: number;
  outstandingPence: number;
  /** The guests' round-ups on a hold. */
  feesPence: number;
  /** The lead paid the restaurant (and the platform fee); this is what comes back to them. */
  owedByGuestsPence: number;
};

const owedOf = (s: Session, b: Bill, p: Participant): number =>
  p.owedPence ?? projectOwedPence(s, b, p.userId);

/** A split's line name, with how many of it when it covers more than one. */
function splitName(item: { name: string }, share: { units?: number }): string {
  const n = share.units ?? 1;
  return n > 1 ? `${n} × ${item.name}` : item.name;
}

function itemsOf(s: Session, b: Bill, p: Participant): StatementLine[] {
  const out: StatementLine[] = [];
  for (const item of b.items) {
    const n = p.claimedItemIds.filter((id) => id === item.itemId).length;
    if (n > 0) {
      out.push({
        label: item.quantity > 1 ? `${item.name} (${n} of ${item.quantity})` : item.name,
        pence: item.unitPricePence * n,
      });
    }
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.includes(p.userId));
    if (share) {
      out.push({
        label: `${splitName(item, share)} (${share.ways === 2 ? 'half' : `1 of ${share.ways} ways`})`,
        pence: sharePence(splitPricePence(item, share), share.userIds, share.ways, p.userId),
      });
    }
  }
  return out;
}

function unclaimedItems(s: Session, b: Bill): StatementLine[] {
  const out: StatementLine[] = [];
  for (const item of b.items) {
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.length > 0);
    let shared = 0;
    if (share) {
      shared = share.units ?? 1;
      const open = share.ways - share.userIds.length;
      if (open > 0) {
        const price = splitPricePence(item, share);
        const taken = share.userIds.reduce((acc, u) => acc + sharePence(price, share.userIds, share.ways, u), 0);
        out.push({ label: `${splitName(item, share)} (${open} of ${share.ways} ways)`, pence: price - taken });
      }
    }
    const taken = s.participants.reduce(
      (acc, p) => acc + p.claimedItemIds.filter((id) => id === item.itemId).length,
      0,
    );
    const left = item.quantity - shared - taken;
    if (left > 0) {
      out.push({
        label: item.quantity > 1 ? `${item.name} (${left} of ${item.quantity})` : item.name,
        pence: item.unitPricePence * left,
      });
    }
  }
  return out;
}

const sum = (lines: readonly StatementLine[]) => lines.reduce((a, l) => a + l.pence, 0);

export function billStatement(
  s: Session,
  b: Bill,
  nameOf: (p: Participant) => string,
): Statement {
  const lead = s.participants.find((p) => p.userId === s.creatorUserId);
  const ordered = [...(lead ? [lead] : []), ...s.participants.filter((p) => p !== lead)];
  const people: PersonStatement[] = ordered.map((p) => {
    const items = itemsOf(s, b, p);
    const totalPence = owedOf(s, b, p);
    let status: PersonStatus = 'lead';
    if (p !== lead) {
      const l = ledger(p, totalPence);
      status = l.settled
        ? 'paid'
        : l.waiting.length > 0
          ? 'says-paid'
          : l.confirmedPence > 0
            ? 'part-paid'
            : 'not-paid';
    }
    const feePence = projectFeePence(s, b, p.userId);
    return { userId: p.userId, name: nameOf(p), status, items, extrasPence: totalPence - sum(items) - feePence, feePence, totalPence };
  });

  const unclaimed = unclaimedItems(s, b);
  // The bill's own money: the platform fee is on top of it.
  const claimedTotal = people.reduce((a, p) => a + p.totalPence - p.feePence, 0);
  const unclaimedTotal = unclaimed.length > 0 ? Math.max(0, b.totalPence - claimedTotal) : 0;

  const payments: PaymentLine[] = [];
  const unpaid: { name: string; pence: number }[] = [];
  let receivedPence = 0;
  let outstandingPence = 0;
  for (const p of ordered) {
    if (p === lead) continue;
    const owed = owedOf(s, b, p);
    const l = ledger(p, owed);
    for (const e of l.entries) {
      const sent = e.status === 'succeeded' || (e.status === 'pending' && !!e.payerClaimedPaidAt);
      if (!sent) continue;
      const at = e.paidAt ?? e.payerClaimedPaidAt;
      payments.push({ name: nameOf(p), ...(at ? { at } : {}), confirmed: e.status === 'succeeded', amountPence: e.amountPence });
    }
    receivedPence += l.confirmedPence;
    const due = Math.max(0, owed - l.confirmedPence);
    outstandingPence += due;
    if (l.sentPence === 0 && owed > 0) unpaid.push({ name: nameOf(p), pence: owed });
  }

  const leadTotal = people.find((p) => p.status === 'lead')?.totalPence ?? 0;
  const feesPence = people.reduce((a, p) => a + p.feePence, 0);
  return {
    itemsPence: b.subtotalPence,
    extrasPence: b.serviceChargePence + b.taxPence,
    totalPence: b.totalPence,
    people,
    unclaimed: { items: unclaimed, extrasPence: unclaimedTotal - sum(unclaimed), totalPence: unclaimedTotal },
    payments,
    unpaid,
    receivedPence,
    outstandingPence,
    feesPence,
    owedByGuestsPence: Math.max(0, b.totalPence - leadTotal - unclaimedTotal) + feesPence,
  };
}

const STATUS_TEXT: Record<PersonStatus, string> = {
  lead: 'Lead',
  paid: 'Paid',
  'says-paid': 'Says they’ve paid',
  'part-paid': 'Part paid',
  'not-paid': 'Not paid',
};
export const statusText = (st: PersonStatus): string => STATUS_TEXT[st];

/** "Sat 21:14" in UK time. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).replace(',', '');
}

/** The statement as plain text, for Copy as text. */
export function statementText(
  st: Statement,
  head: { title: string; leadName: string; feePence?: number },
): string {
  const line = (k: string, v: number | string) =>
    `${k}${' '.repeat(Math.max(1, 34 - k.length))}${typeof v === 'number' ? formatGBP(v) : v}`;
  const out: string[] = [head.title, ''];
  out.push('The bill', line('Items', st.itemsPence));
  if (st.extrasPence > 0) out.push(line('Service', st.extrasPence));
  out.push(line('Bill total', st.totalPence));
  if (head.feePence) out.push(`Platform fee ${formatGBP(head.feePence)}, paid by ${head.leadName}.`);
  for (const p of st.people) {
    out.push('', `${p.name} · ${statusText(p.status)}`);
    for (const i of p.items) out.push(line(i.label, i.pence));
    if (p.extrasPence > 0) out.push(line('Service', p.extrasPence));
    if (p.feePence > 0) out.push(line('Round-up', p.feePence));
    out.push(line('Total', p.totalPence));
  }
  if (st.unclaimed.items.length > 0) {
    out.push('', `Nobody claimed · goes to ${head.leadName}`);
    for (const i of st.unclaimed.items) out.push(line(i.label, i.pence));
    if (st.unclaimed.extrasPence > 0) out.push(line('Service', st.unclaimed.extrasPence));
    out.push(line('Total', st.unclaimed.totalPence));
  }
  out.push('', `Payments to ${head.leadName}`);
  for (const p of st.payments) {
    out.push(line(`${p.name}${p.at ? ` ${whenText(p.at)}` : ''}${p.confirmed ? ', confirmed' : ''}`, p.amountPence));
  }
  for (const u of st.unpaid) out.push(line(`${u.name}, not paid`, u.pence));
  out.push(line('Received', st.receivedPence), line('Outstanding', st.outstandingPence));
  out.push('', `${head.leadName}’s position`, line('Paid the restaurant', st.totalPence));
  if (head.feePence) out.push(line('Paid the platform fee', head.feePence));
  const own = st.people.find((p) => p.status === 'lead')?.totalPence ?? 0;
  out.push(line('Own share', -own));
  if (st.unclaimed.totalPence > 0) out.push(line('Nobody claimed', -st.unclaimed.totalPence));
  out.push(line('Owed by guests', st.owedByGuestsPence));
  return out.join('\n');
}
