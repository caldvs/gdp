'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed (the
 * lead can take it, or cover the lot), and one way out: Close bill.
 * Everything updates on the session's poll.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type components } from '@gdp/core/api';
import { useAbandonSession, useAddShare, useCloseSession, useRemoveShare, useSetClaims, useSetExpectedDiners, useSetShareWays, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useConfirmPayment } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { coverLeftovers } from '@gdp/core/lib/leftovers';
import { projectOwedPence, sharePence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  ActionBar, AvatarStack, BackLink, Badge, Box, Button, Dialog, Notice, Page, Avatar, Row, Section, Stats, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';
import { PickRow, SplitSheet, Stepper, itemStatuses, splitSub, useChangeFeed } from './guest';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

function owedFor(s: Session, b: Bill, p: Participant): number {
  return p.owedPence ?? projectOwedPence(s, b, p.userId);
}
// #121: a guest can pay more than once; the lead has collected what's been
// confirmed, and a guest is done when nothing is due or waiting.
const confirmedFor = (s: Session, b: Bill, p: Participant) => ledger(p, owedFor(s, b, p)).confirmedPence;
const isPaid = (s: Session, b: Bill, p: Participant) => ledger(p, owedFor(s, b, p)).settled;
const stillToCollect = (s: Session, b: Bill, p: Participant) => Math.max(0, owedFor(s, b, p) - confirmedFor(s, b, p));

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
  // #123: an item a tap just lost the race for, and whether taken-by-others rows are folded away.
  const [raceLostItemId, setRaceLostItemId] = useState<string | null>(null);
  const [hideTaken, setHideTaken] = useState(false);
  // #64: how many the lead said are eating, lead included. Display only.
  const setExpected = useSetExpectedDiners(s.sessionId);
  const [sizing, setSizing] = useState<number | null>(null);
  const joined = s.participants.length;
  const everyoneHere = s.expectedDiners !== undefined && joined >= s.expectedDiners;

  const me = s.participants.find((p) => p.userId === meUserId);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => acc + stillToCollect(s, b, p), 0);
  const collected = guests.reduce((acc, p) => acc + confirmedFor(s, b, p), 0);
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const { changes, liveText } = useChangeFeed(statuses);
  const unclaimed = statuses.filter((x) => x.left > 0);
  const unclaimedPence = unclaimed.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0);
  // What "I'll cover these" takes: every unclaimed unit that isn't in a split.
  const cover = coverLeftovers(s, statuses, me?.claimedItemIds ?? []);
  const coverable = cover.lines;
  const coverPence = cover.pence;
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending;

  const takeOne = (itemId: string) => {
    if (!me) return;
    setRaceLostItemId(null);
    setClaims.mutate(
      { claimedItemIds: [...me.claimedItemIds, itemId] },
      {
        onError: (e) => {
          const errItemId = e instanceof ApiError ? (e.details as { itemId?: string } | undefined)?.itemId : undefined;
          if (e instanceof ApiError && e.code === 'SESSION_INVALID_STATE' && errItemId === itemId) {
            setRaceLostItemId(itemId);
          }
        },
      },
    );
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
    setClaims.mutate({ claimedItemIds: cover.claimedItemIds });
  };

  // #123: rows stay in bill order and in place; a taken-by-others row never
  // vanishes, it just flashes and says what happened.
  const rows = statuses.map(({ item, left, mine, who, share }) => {
    const others = who.filter((n) => n !== 'you');
    const name = item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name;
    const change = changes.get(item.itemId);
    if (share) {
      // A split: anyone can join, the lead included.
      const inIt = share.userIds.includes(meUserId);
      const seats = Math.max(0, share.ways - share.userIds.length);
      const myWays = inIt || seats > 0 ? share.ways : share.ways + 1;
      return {
        taken: false,
        el: (
          <PickRow
            key={item.itemId}
            on={inIt}
            changed={!!change}
            busy={busy}
            action={inIt ? 'Leave the split for' : 'Join the split for'}
            onTap={() => (inIt ? removeShare.mutate({ itemId: item.itemId }) : addShare.mutate({ itemId: item.itemId }))}
            name={name}
            sub={change?.text ?? splitSub(s, share, meUserId)}
            price={<>{formatGBP(sharePence(item.unitPricePence, share.userIds, myWays, meUserId))}<span className="each">each</span></>}
            aside={inIt ? <Button tone="text" small onClick={() => setSplitting({ item, ways: share.ways, share })} aria-label={`Change how many ways ${item.name} is split`}>{share.ways} ways</Button> : undefined}
          />
        ),
      };
    }
    if (mine > 0 && item.quantity > 1) {
      return {
        taken: false,
        el: (
          <PickRow
            key={item.itemId}
            on
            changed={!!change}
            name={name}
            sub={change?.text ?? (others.length ? `You and ${others.join(', ')}` : `${formatGBP(item.unitPricePence)} each`)}
            price={formatGBP(item.unitPricePence * mine)}
            aside={<Stepper n={mine} max={mine + left} busy={busy} onDec={() => dropOne(item.itemId)} onInc={() => takeOne(item.itemId)} name={item.name} />}
          />
        ),
      };
    }
    if (left > 0) {
      const sub = [others.length ? others.join(', ') : 'Not claimed', item.quantity > 1 ? `${left} left · ${formatGBP(item.unitPricePence)} each` : null].filter(Boolean).join(' · ');
      return {
        taken: false,
        el: (
          <PickRow
            key={item.itemId}
            changed={!!change}
            busy={busy}
            action="Take"
            onTap={() => takeOne(item.itemId)}
            name={name}
            sub={change?.text ?? sub}
            price={formatGBP(item.unitPricePence * left)}
            aside={others.length > 0 ? <AvatarStack names={others} /> : item.quantity === 1 ? <Button tone="text" small onClick={() => setSplitting({ item, ways: 2 })} aria-label={`Split ${item.name}`}>Split</Button> : undefined}
          />
        ),
      };
    }
    if (mine > 0) {
      return { taken: false, el: <PickRow key={item.itemId} on busy={busy} action="Hand back" onTap={() => dropOne(item.itemId)} name={name} sub="You" price={formatGBP(item.unitPricePence)} /> };
    }
    const justTaken = raceLostItemId === item.itemId;
    return {
      taken: true,
      el: (
        <PickRow
          key={item.itemId}
          taken
          changed={!!change || justTaken}
          name={name}
          sub={justTaken ? `${others[others.length - 1] ?? 'Someone'} just took this` : change?.text}
          aside={<AvatarStack names={others} />}
          price={formatGBP(item.unitPricePence * item.quantity)}
        />
      ),
    };
  });
  const leadRows = { rows, taken: rows.filter((r) => r.taken) };

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title={b.venue?.name ?? 'Your bill'} sub={s.joinCode ? `Code ${s.joinCode}` : undefined} />
        <BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode} />
        <Stats items={[
          { k: 'Bill', v: formatGBP(b.totalPence) },
          { k: 'Collected', v: formatGBP(collected) },
          { k: 'To collect', v: formatGBP(toCome), warn: toCome > 0 },
        ]} />

        <Section title={s.expectedDiners !== undefined ? `People · ${joined} of ${s.expectedDiners} joined` : 'People'}>
          <p className="small muted" style={{ textAlign: 'right' }}>
            <button type="button" className="link-btn" onClick={() => { setExpected.reset(); setSizing(s.expectedDiners ?? Math.max(2, joined)); }}>
              {s.expectedDiners !== undefined ? 'Change number' : 'How many eating?'}
            </button>
          </p>
          <Box>
            {guests.length === 0 ? (
              <Row title="Nobody’s joined yet" sub="Show them the QR code. People appear here as they join." muted />
            ) : guests.map((p) => (
              <PersonRow key={p.userId} p={p} owed={owedFor(s, b, p)} busy={confirm.isPending} onConfirm={(paymentId) => confirm.mutate(paymentId)} />
            ))}
          </Box>
          {confirm.isError ? <Notice tone="error">{confirm.error.message}</Notice> : null}
        </Section>

        <Section title={unclaimed.length > 0 ? `Items · ${formatGBP(unclaimedPence)} not claimed yet` : 'Items · all claimed'}>
          <div className="vh" aria-live="polite">{liveText}</div>
          {everyoneHere && unclaimed.length > 0 ? (
            <Notice tone="warn" title="Everyone’s here">{formatGBP(unclaimedPence)} still not claimed.</Notice>
          ) : null}
          {!hideTaken && leadRows.taken.length > 0 ? (
            <p className="small muted" style={{ textAlign: 'right' }}>
              <button type="button" className="link-btn" onClick={() => setHideTaken(true)}>Hide taken</button>
            </p>
          ) : null}
          <Box>
            {(hideTaken ? leadRows.rows.filter((r) => !r.taken) : leadRows.rows).map((r) => r.el)}
            {hideTaken && leadRows.taken.length > 0 ? (
              <button type="button" className="pick pick--fold" onClick={() => setHideTaken(false)}>Show taken ({leadRows.taken.length})</button>
            ) : null}
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
      {sizing !== null ? (
        <PartySizeSheet
          n={sizing}
          min={2}
          busy={setExpected.isPending}
          error={setExpected.error?.message}
          canClear={s.expectedDiners !== undefined}
          onChange={setSizing}
          onCancel={() => setSizing(null)}
          onOk={(expectedDiners) => setExpected.mutate({ expectedDiners }, { onSuccess: () => setSizing(null) })}
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

function PersonRow({ p, owed, onConfirm, busy }: { p: Participant; owed: number; onConfirm: (paymentId: string) => void; busy: boolean }) {
  const name = firstName(p.displayName, 'Guest');
  const av = <Avatar name={p.displayName || name} />;
  const l = ledger(p, owed);
  // Payments they say they've sent, oldest first: the lead confirms each.
  const next = l.waiting[0];
  if (l.settled) return <Row lead={av} title={name} sub={formatGBP(owed)} end={<Badge tone="ok">Paid</Badge>} />;
  if (next) {
    const sub = l.confirmedPence > 0
      ? `Says they’ve paid ${formatGBP(next.amountPence)} more`
      : `Says they’ve paid ${formatGBP(next.amountPence)}`;
    return (
      <Row
        lead={av}
        title={name}
        sub={l.waiting.length > 1 ? `${sub} (${l.waiting.length} to confirm)` : sub}
        end={<Button small onClick={() => onConfirm(next.paymentId)} disabled={busy} aria-label={`Confirm ${name} paid ${formatGBP(next.amountPence)}`}>Confirm</Button>}
      />
    );
  }
  if (l.confirmedPence > 0) {
    // Paid once, then took more: the rest is still to come.
    return <Row lead={av} title={name} sub={`Paid ${formatGBP(l.confirmedPence)} · owes ${formatGBP(l.duePence)} more`} end={formatGBP(owed)} />;
  }
  return <Row lead={av} title={name} sub={l.draft ? 'Paying' : 'Not paid'} end={formatGBP(owed)} />;
}

/* ============================ closed ============================ */

export function LeadSettled({ s, b }: { s: Session; b: Bill }) {
  // Guests can still pay after the bill is closed, so the lead can still confirm.
  const confirm = useConfirmPayment(s.sessionId);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const outstanding = guests.filter((p) => !isPaid(s, b, p));
  const collected = guests.reduce((acc, p) => acc + confirmedFor(s, b, p), 0);
  const yourPart = Math.max(0, b.totalPence - guests.reduce((acc, p) => acc + owedFor(s, b, p), 0));
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title={b.venue?.name ?? 'Your bill'} sub="Bill closed" />
        <BillTools sessionId={s.sessionId} billId={s.billId} showQr={false} />
        {outstanding.length === 0
          ? <Notice tone="ok" title={`${formatGBP(collected)} collected`}>Everyone has paid.</Notice>
          : <Notice title={`${outstanding.length} still to pay`}>{formatGBP(collected)} collected so far.</Notice>}
        {guests.length > 0 ? (
          <Section title="People">
            <Box>{guests.map((p) => (
              <PersonRow key={p.userId} p={p} owed={owedFor(s, b, p)} busy={confirm.isPending} onConfirm={(paymentId) => confirm.mutate(paymentId)} />
            ))}</Box>
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

const PARTY_MAX = 99;

function PartySizeSheet({ n, min, busy, error, canClear, onChange, onCancel, onOk }: {
  n: number; min: number; busy: boolean; error?: string; canClear: boolean; onChange: (n: number) => void; onCancel: () => void; onOk: (n: number | null) => void;
}) {
  return (
    <Dialog
      id="party-t"
      title="How many eating?"
      onClose={onCancel}
      actions={
        <>
          <Button busy={busy} onClick={() => onOk(n)}>Save</Button>
          {canClear ? <Button tone="secondary" disabled={busy} onClick={() => onOk(null)}>Not sure</Button> : null}
          <Button tone="secondary" onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <p className="muted">Including you.</p>
      <div className="ways">
        <span className="stepper">
          <button type="button" aria-label="Fewer people" disabled={n <= min} onClick={() => onChange(n - 1)}>−</button>
        </span>
        <b aria-live="polite">{n}</b>
        <span className="stepper">
          <button type="button" aria-label="More people" disabled={n >= PARTY_MAX} onClick={() => onChange(n + 1)}>+</button>
        </span>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}

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
