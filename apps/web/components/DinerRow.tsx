import type { components } from '@gdp/core/api';
import { formatGBP } from '@gdp/core/lib/money';
import { sharePence } from '@gdp/core/lib/owed';
import { Avatar } from './Avatar';
import { Chip, Mini } from './ui';

type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type SessionShares = NonNullable<components['schemas']['Session']['shares']>;

export function DinerRow({ p, isMe, isLead, variant, items, billExtrasRate, shares, fallbackOwedPence, onMarkReceived, onChase }: {
  p: Participant; isMe: boolean; isLead: boolean; variant: 'claiming' | 'paying' | 'settled'; fallbackOwedPence?: number;
  items?: BillItem[]; billExtrasRate?: number; shares?: SessionShares;
  onMarkReceived?: () => void; onChase?: () => void;
}) {
  // While claiming, owedPence isn't computed yet — project it from picks
  // the same way the server will at lock time (shares: price / number of
  // ways; then pro-rata service + tax).
  let amountPence: number | undefined = p.owedPence ?? fallbackOwedPence;
  let shareCount = 0;
  if (variant === 'claiming' && items && billExtrasRate !== undefined) {
    const claimSub = p.claimedItemIds.reduce((acc, id) => acc + (items.find((x) => x.itemId === id)?.unitPricePence ?? 0), 0);
    const shareSub = (shares ?? []).reduce((acc, sh) => {
      if (!sh.userIds.includes(p.userId)) return acc;
      shareCount += 1;
      const item = items.find((x) => x.itemId === sh.itemId);
      if (!item) return acc;
      return acc + sharePence(item.unitPricePence, sh.userIds, sh.ways ?? sh.userIds.length, p.userId);
    }, 0);
    amountPence = Math.round((claimSub + shareSub) * (1 + billExtrasRate));
  }
  const pickCount = p.claimedItemIds.length + shareCount;
  const subLine = variant === 'claiming'
    ? `${pickCount} pick${pickCount === 1 ? '' : 's'}${amountPence ? ` · ${formatGBP(amountPence)}` : ''}`
    : null;

  return (
    <div className="diner">
      <Avatar uri={p.avatarUrl} displayName={p.displayName} seed={p.userId} size={36} />
      <div className="diner__body">
        <div className="diner__name">
          {p.displayName}{isMe ? ' (you)' : ''}
          {isLead ? <span className="diner__host">  · host</span> : null}
        </div>
        {subLine ? <Mini style={{ marginTop: 2 }}>{subLine}</Mini> : null}
      </div>
      <div className="diner__right">
        {amountPence !== undefined && variant !== 'claiming' ? <span className="diner__amount">{formatGBP(amountPence)}</span> : null}
        <DinerStatus p={p} variant={variant} isLead={isLead} onMarkReceived={onMarkReceived} onChase={onChase} />
      </div>
    </div>
  );
}

function DinerStatus({ p, variant, isLead, onMarkReceived, onChase }: {
  p: Participant; variant: 'claiming' | 'paying' | 'settled'; isLead: boolean; onMarkReceived?: () => void; onChase?: () => void;
}) {
  if (variant === 'claiming') {
    if (isLead) return <Chip>host</Chip>;
    return p.readyToLock ? <Chip variant="ok">ready</Chip> : <Chip variant="live">picking</Chip>;
  }
  if (variant === 'paying') {
    const st = p.payment.status;
    if (st === 'self_paid' || isLead) return <Chip>collector</Chip>;
    if (st === 'succeeded') return <Chip variant="ok">paid</Chip>;
    if (st === 'pending') {
      if (onMarkReceived) return <button type="button" className="diner__action" onClick={onMarkReceived}>mark received</button>;
      return <Chip variant="live">{p.payment.payerClaimedPaidAt ? 'says paid' : 'pending'}</Chip>;
    }
    if (st === 'failed') return <Chip variant="accent">failed</Chip>;
    if (onChase) return <button type="button" className="diner__action diner__action--ghost" onClick={onChase}>chase →</button>;
    return <Chip variant="live">unpaid</Chip>;
  }
  if (p.payment.status === 'self_paid' || isLead) return <Chip>collector</Chip>;
  return <Chip variant="ok">paid</Chip>;
}
