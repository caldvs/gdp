'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed (the
 * lead can take it, or cover the lot), and one way out: Close bill.
 * Everything updates on the session's poll.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type components } from '@gdp/core/api';
import { useAbandonSession, useAddShare, useCloseSession, useRemoveShare, useSetClaims, useSetShareWays, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useConfirmPayment } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { projectOwedPence, sharePence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  ActionBar, BackLink, Badge, Box, Button, Dialog, Notice, Page, QrIcon, Row, Section, Stats, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { PickRow, SplitSheet, Stepper, itemStatuses, splitSub } from './guest';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

function owedFor(s: Session, b: Bill, p: Participant): number {
  return p.owedPence ?? projectOwedPence(s, b, p.userId);
}
const isPaid = (p: Participant) => p.payment.status === 'succeeded' || p.payment.status === 'self_paid';

/* ============================ setup ============================ */

export function LeadSetup({ s, b }: { s: Session; b: Bill }) {
  const router = useRouter();
  const share = useShareSession(s.sessionId);
  const payout = usePayoutAccount();
  const onShare = () => {
    if (!payout.data) { router.push(`/payout-account?returnTo=${encodeURIComponent(`/session/${s.sessionId}`)}`); return; }
    share.mutate(undefined, { onSuccess: () => router.replace(`/session/${s.sessionId}/share`) });
  };
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title={b.venue?.name ?? 'Your bill'} sub={`${b.items.length} ${b.items.length === 1 ? 'item' : 'items'} · ${formatGBP(b.totalPence)} · not shared yet`} />
        {share.isError ? <Notice tone="error">{share.error.message}</Notice> : null}
      </Page>
      <ActionBar>
        <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
        <Button grow busy={share.isPending} onClick={onShare}>Share with the table</Button>
      </ActionBar>
    </>
  );
}

/* ============================ the bill ============================ */

export function LeadTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const router = useRouter();
  const close = useCloseSession(s.sessionId);
  const abandon = useAbandonSession(s.sessionId);
  const confirm = useConfirmPayment(s.sessionId);
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const removeShare = useRemoveShare(s.sessionId);
  const setWays = useSetShareWays(s.sessionId);
  const [splitting, setSplitting] = useState<{ item: BillItem; ways: number; share?: Share } | null>(null);
  const [closing, setClosing] = useState(false);
  const [binning, setBinning] = useState(false);

  const me = s.participants.find((p) => p.userId === meUserId);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => (isPaid(p) ? acc : acc + owedFor(s, b, p)), 0);
  const collected = guests.reduce((acc, p) => (isPaid(p) ? acc + owedFor(s, b, p) : acc), 0);
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const unclaimed = statuses.filter((x) => x.left > 0);
  const unclaimedPence = unclaimed.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0);
  // What "I'll cover these" takes: every unclaimed unit that isn't in a
  // split (an item is claimed or split, never both).
  const sharedIds = new Set(s.participants.flatMap((p) => p.sharedItemIds));
  const coverable = unclaimed.filter((x) => !sharedIds.has(x.item.itemId) && !x.share);
  const coverPence = coverable.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0);
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending;

  const takeOne = (itemId: string) => {
    if (!me) return;
    setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, itemId] });
  };
  const dropOne = (itemId: string) => {
    if (!me) return;
    const next = [...me.claimedItemIds];
    const i = next.lastIndexOf(itemId);
    if (i < 0) return;
    next.splice(i, 1);
    setClaims.mutate({ claimedItemIds: next });
  };
  const coverAll = () => {
    if (!me || coverable.length === 0) return;
    setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, ...coverable.flatMap((x) => Array<string>(x.left).fill(x.item.itemId))] });
  };

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title
          title={b.venue?.name ?? 'Your bill'}
          sub={s.joinCode ? `Code ${s.joinCode}` : undefined}
          aside={s.joinCode ? <Button tone="secondary" small href={`/session/${s.sessionId}/share`} aria-label="Show QR code"><QrIcon />QR code</Button> : undefined}
        />
        <Stats items={[
          { k: 'Bill', v: formatGBP(b.totalPence) },
          { k: 'Collected', v: formatGBP(collected) },
          { k: 'To collect', v: formatGBP(toCome), warn: toCome > 0 },
        ]} />

        <Section title="People">
          <Box>
            {guests.length === 0 ? (
              <Row title="Nobody’s joined yet" sub="Show them the QR code" muted />
            ) : guests.map((p) => (
              <PersonRow key={p.userId} p={p} owed={owedFor(s, b, p)} busy={confirm.isPending} onConfirm={p.payment.status === 'pending' ? () => confirm.mutate(p.payment.status === 'pending' ? p.payment.paymentId : '') : undefined} />
            ))}
          </Box>
          {confirm.isError ? <Notice tone="error">{confirm.error.message}</Notice> : null}
        </Section>

        <Section title={unclaimed.length > 0 ? `Items · ${formatGBP(unclaimedPence)} not claimed yet` : 'Items · all claimed'}>
          <Box>
            {statuses.map(({ item, left, mine, who, share }) => {
              const others = who.filter((n) => n !== 'you');
              const name = item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name;
              if (share) {
                // A split: anyone can join, the lead included.
                const inIt = share.userIds.includes(meUserId);
                const seats = Math.max(0, share.ways - share.userIds.length);
                const myWays = inIt || seats > 0 ? share.ways : share.ways + 1;
                return (
                  <PickRow
                    key={item.itemId}
                    on={inIt}
                    busy={busy}
                    label={inIt ? `Leave the split for ${item.name}` : `Join the split for ${item.name}`}
                    onTap={() => (inIt ? removeShare.mutate({ itemId: item.itemId }) : addShare.mutate({ itemId: item.itemId }))}
                    name={name}
                    sub={splitSub(s, share, meUserId)}
                    price={<>{formatGBP(sharePence(item.unitPricePence, share.userIds, myWays, meUserId))}<span className="each">each</span></>}
                    aside={inIt ? <Button tone="text" small onClick={() => setSplitting({ item, ways: share.ways, share })} aria-label={`Change how many ways ${item.name} is split`}>{share.ways} ways</Button> : undefined}
                  />
                );
              }
              if (mine > 0 && item.quantity > 1) {
                return (
                  <PickRow
                    key={item.itemId}
                    on
                    name={name}
                    sub={others.length ? `You and ${others.join(', ')}` : `${formatGBP(item.unitPricePence)} each`}
                    price={formatGBP(item.unitPricePence * mine)}
                    aside={<Stepper n={mine} max={mine + left} busy={busy} onDec={() => dropOne(item.itemId)} onInc={() => takeOne(item.itemId)} name={item.name} />}
                  />
                );
              }
              if (left > 0) {
                const sub = [others.length ? others.join(', ') : 'Not claimed', item.quantity > 1 ? `${left} left · ${formatGBP(item.unitPricePence)} each` : null].filter(Boolean).join(' · ');
                return (
                  <PickRow
                    key={item.itemId}
                    busy={busy}
                    label={`Take ${item.name}`}
                    onTap={() => takeOne(item.itemId)}
                    name={name}
                    sub={sub}
                    price={formatGBP(item.unitPricePence * left)}
                    aside={item.quantity === 1 ? <Button tone="text" small onClick={() => setSplitting({ item, ways: 2 })} aria-label={`Split ${item.name}`}>Split</Button> : undefined}
                  />
                );
              }
              if (mine > 0) {
                return <PickRow key={item.itemId} on busy={busy} label={`Hand back ${item.name}`} onTap={() => dropOne(item.itemId)} name={name} sub="You" price={formatGBP(item.unitPricePence)} />;
              }
              return <PickRow key={item.itemId} taken name={name} sub={others.join(', ')} price={formatGBP(item.unitPricePence * item.quantity)} />;
            })}
          </Box>
          {coverable.length > 0 ? (
            <Button tone="secondary" busy={setClaims.isPending} onClick={coverAll}>I’ll cover these · {formatGBP(coverPence)}</Button>
          ) : null}
          {unclaimed.length > 0 ? <p className="small muted">Tap an item to take it yourself. Anything left when you close is yours.</p> : null}
          {setClaims.isError ? <Notice tone="error">{setClaims.error.message}</Notice> : null}
          {addShare.isError ? <Notice tone="error">{addShare.error.message}</Notice> : null}
          {removeShare.isError ? <Notice tone="error">{removeShare.error.message}</Notice> : null}
        </Section>

        <Button tone="text" className="btn--text-danger" onClick={() => setBinning(true)} style={{ alignSelf: 'flex-start', width: 'auto', padding: 0 }}>Delete this bill</Button>
      </Page>
      <ActionBar>
        <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
        <Button grow onClick={() => setClosing(true)}>Close bill</Button>
      </ActionBar>

      {splitting ? (
        <SplitSheet
          item={splitting.item}
          ways={splitting.ways}
          min={Math.max(2, splitting.share?.userIds.length ?? 1)}
          busy={addShare.isPending || setWays.isPending}
          error={setWays.error instanceof ApiError ? setWays.error.message : undefined}
          onChange={(ways) => setSplitting({ ...splitting, ways })}
          onCancel={() => { setSplitting(null); setWays.reset(); }}
          onOk={() => {
            const done = () => setSplitting(null);
            if (splitting.share) setWays.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
            else addShare.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
          }}
        />
      ) : null}
      {closing ? (
        <Confirm
          title="Close the bill?"
          body={[
            unclaimedPence > 0 ? `${formatGBP(unclaimedPence)} not claimed goes on you.` : null,
            toCome > 0 ? `${formatGBP(toCome)} still to collect. People can still pay.` : null,
          ].filter(Boolean).join(' ') || 'Everyone has paid.'}
          ok="Close bill"
          busy={close.isPending}
          error={close.error?.message}
          onOk={() => close.mutate(undefined, { onSuccess: () => setClosing(false) })}
          onCancel={() => setClosing(false)}
        />
      ) : null}
      {binning ? (
        <Confirm
          title="Delete this bill?"
          body={guests.length > 0 ? `${guests.length} ${guests.length === 1 ? 'person loses' : 'people lose'} their picks. This can’t be undone.` : 'This can’t be undone.'}
          ok="Delete bill"
          danger
          busy={abandon.isPending}
          error={abandon.error?.message}
          onOk={() => abandon.mutate(undefined, { onSuccess: () => router.replace('/') })}
          onCancel={() => setBinning(false)}
        />
      ) : null}
    </>
  );
}

function PersonRow({ p, owed, onConfirm, busy }: { p: Participant; owed: number; onConfirm?: () => void; busy: boolean }) {
  const saysPaid = p.payment.status === 'pending' && !!p.payment.payerClaimedPaidAt;
  const name = firstName(p.displayName, 'Guest');
  if (isPaid(p)) return <Row title={name} sub={formatGBP(owed)} end={<Badge tone="ok">Paid</Badge>} />;
  if (saysPaid && onConfirm) {
    return (
      <Row
        title={name}
        sub={`Says they’ve paid ${formatGBP(owed)}`}
        end={<Button small onClick={onConfirm} disabled={busy} aria-label={`Confirm ${name} paid ${formatGBP(owed)}`}>Confirm</Button>}
      />
    );
  }
  return <Row title={name} sub={p.payment.status === 'pending' ? 'Paying' : 'Not paid'} end={formatGBP(owed)} />;
}

/* ============================ closed ============================ */

export function LeadSettled({ s, b }: { s: Session; b: Bill }) {
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const outstanding = guests.filter((p) => !isPaid(p));
  const collected = guests.reduce((acc, p) => (isPaid(p) ? acc + owedFor(s, b, p) : acc), 0);
  const yourPart = Math.max(0, b.totalPence - guests.reduce((acc, p) => acc + owedFor(s, b, p), 0));
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title={b.venue?.name ?? 'Your bill'} sub="Bill closed" />
        {outstanding.length === 0
          ? <Notice tone="ok" title={`${formatGBP(collected)} collected`}>Everyone has paid.</Notice>
          : <Notice title={`${outstanding.length} still to pay`}>{formatGBP(collected)} collected so far.</Notice>}
        {guests.length > 0 ? (
          <Section title="People">
            <Box>{guests.map((p) => <PersonRow key={p.userId} p={p} owed={owedFor(s, b, p)} busy={false} />)}</Box>
          </Section>
        ) : null}
        <Totals>
          <TotalLine k="Bill" v={formatGBP(b.totalPence)} />
          <TotalLine tone="total" k="Your part" v={formatGBP(yourPart)} />
        </Totals>
      </Page>
      <ActionBar><Button grow href="/" replace>Done</Button></ActionBar>
    </>
  );
}

/* ============================ deleted ============================ */

export function Ended({ s, isCreator }: { s: Session; isCreator: boolean }) {
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="This bill was deleted" sub={isCreator ? 'You can scan the bill again to start over.' : `${firstName(host?.displayName)} deleted it.`} />
      </Page>
      <ActionBar><Button grow href="/" replace>Back to bills</Button></ActionBar>
    </>
  );
}

/* ============================ bits ============================ */

function Confirm({ title, body, ok, danger, busy, error, onOk, onCancel }: {
  title: string; body: string; ok: string; danger?: boolean; busy: boolean; error?: string; onOk: () => void; onCancel: () => void;
}) {
  return (
    <Dialog
      id="confirm-t"
      title={title}
      onClose={onCancel}
      actions={
        <>
          <Button tone={danger ? 'danger' : 'primary'} busy={busy} onClick={onOk}>{ok}</Button>
          <Button tone="secondary" onClick={onCancel}>Not yet</Button>
        </>
      }
    >
      <p className="muted">{body}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}
