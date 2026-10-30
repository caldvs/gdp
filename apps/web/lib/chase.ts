import type { components } from '@gdp/core/api';
import { formatGBP } from '@gdp/core/lib/money';
import { copyText } from './clipboard';

type Participant = components['schemas']['Participant'];

const STALE_CLAIM_MS = 30 * 60_000;

/** Unpaid, or "says paid" for over 30 minutes with nothing arriving. */
export function shouldShowChase(payment: Participant['payment']): boolean {
  if (payment.status === 'unpaid') return true;
  if (payment.status === 'pending' && payment.payerClaimedPaidAt) {
    const claimedAt = Date.parse(payment.payerClaimedPaidAt);
    return !Number.isNaN(claimedAt) && Date.now() - claimedAt > STALE_CLAIM_MS;
  }
  return false;
}

export function chaseMessage(p: Participant, fromName: string): string {
  const amount = p.owedPence !== undefined ? formatGBP(p.owedPence) : 'your share';
  const staleClaim = p.payment.status === 'pending' && p.payment.payerClaimedPaidAt;
  return staleClaim
    ? `Hey ${p.displayName} — quick one, you marked your ${amount} as paid for the bill but it hasn't come through to me yet. Mind double-checking? Thanks! — ${fromName}`
    : `Hey ${p.displayName} — gentle nudge, you owe ${amount} from the bill the other night. Send it whenever and I'll mark it off. Thanks! — ${fromName}`;
}

/** Share sheet on phones; clipboard elsewhere. Returns what happened. */
export async function chaseDiner(p: Participant, fromName: string): Promise<'shared' | 'copied' | 'failed'> {
  const text = chaseMessage(p, fromName);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch {
      // cancelled or unsupported — fall back to clipboard
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}
