'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed (the
 * lead can take it, or cover the lot), and one way out: Close bill.
 * Everything updates on the session's poll.
 */
import { startTransition, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { components } from '@gdp/core/api';
import { isFeeRequired, useAbandonSession, useAddShare, useCloseSession, useSetClaims, useSetExpectedDiners, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useConfirmPayment } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { claimRows, type ClaimRow } from '@gdp/core/lib/claimRows';
import { extrasRate, projectFeePence, projectOwedPence, sharePence, splitPricePence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  ActionBar, Avatar, BackLink, Badge, Box, Button, Dialog, Notice, Page, Pulse, Row, RowButton, RowLink, Section, TabPanel, Tabs, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';
import { billTitle } from '@/components/PageTransition';
import { itemStatuses } from './guest';
import { ClaimList } from './claim';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];

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
    share.mutate(undefined, {
      onSuccess: () => router.replace(`/session/${s.sessionId}/share?new=1`),
      // No fee or credit for it: pay first, then the fee page shares this table.
      onError: (err) => { if (isFeeRequired(err)) router.push(`/table-fee/${s.billId}`); },
    });
  };
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub={`${b.items.length} ${b.items.length === 1 ? 'item' : 'items'} · ${formatGBP(b.totalPence)} · not shared yet`} />
        {share.isError && !isFeeRequired(share.error) ? <Notice tone="error">{share.error.message}</Notice> : null}
      </Page>
      <ActionBar>
        <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
        <Button grow busy={share.isPending} onClick={onShare}>Share with the table</Button>
      </ActionBar>
    </>
  );
}

/* ============================ the bill ============================ */

type LeadTab = 'mine' | 'table';

/**
 * The lead's live bill (#131, board L4.1/L4.2): two tabs. Your items is
 * the same claiming list guests use; The table is who's paid, what nobody
 * has claimed yet, and the way to the full summary.
 */
export function LeadTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const router = useRouter();
  const close = useCloseSession(s.sessionId);
  const abandon = useAbandonSession(s.sessionId);
  const confirm = useConfirmPayment(s.sessionId);
  const me = s.participants.find((p) => p.userId === meUserId);
  // Straight after sharing the lead has nothing yet: start on their items.
  const [tab, setTab] = useState<LeadTab>(() => (me && (me.claimedItemIds.length > 0 || me.sharedItemIds.length > 0) ? 'table' : 'mine'));
  const [leftOpen, setLeftOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [binning, setBinning] = useState(false);
  // #64: how many the lead said are eating, lead included. Display only.
  const setExpected = useSetExpectedDiners(s.sessionId);
  const [sizing, setSizing] = useState<number | null>(null);
  const joined = s.participants.length;
  const everyoneHere = s.expectedDiners !== undefined && joined >= s.expectedDiners;

  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => acc + stillToCollect(s, b, p), 0);
  // Nobody joined: closing or deleting gives back what sharing cost (#132).
  const spent = useSpent(s.sessionId, guests.length === 0);
  const giveBack = spent.fee?.kind === 'hold' && !spent.fee.releasedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} hold is released.`
    : spent.fee && spent.fee.kind !== 'hold' && !spent.fee.refundedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} fee is refunded.`
    : spent.credit && !spent.credit.returnedAt ? 'Nobody joined, so you get your credit back.' : null;
  // #167: at close the guests' part of the platform fee comes off the hold.
  const guestFees = guests.reduce((acc, p) => acc + projectFeePence(s, b, p.userId), 0);
  const holdNote = s.platformFeePence && guests.length > 0
    ? guestFees >= 30 ? `${formatGBP(guestFees)} of your ${formatGBP(s.platformFeePence)} hold is taken; your guests pay it back.` : `Your ${formatGBP(s.platformFeePence)} hold is released.`
    : null;
  const rate = extrasRate(b);
  const myOwed = projectOwedPence(s, b, meUserId);
  const rows = useMemo(() => claimRows(s, b, meUserId), [s, b, meUserId]);
  const left = rows.filter((r) => r.group === 'open');
  const leftPence = left.reduce((acc, r) => acc + openPence(r), 0);
  const leftWithService = Math.round(leftPence * (1 + rate));
  const myItems = rows.filter((r) => r.group === 'yours').map((r) => r.item.name);

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub={s.joinCode ? `Code ${s.joinCode}` : undefined} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode} />} />
        <Tabs label="The bill" value={tab} onChange={(t) => startTransition(() => setTab(t))} tabs={[{ id: 'mine', label: 'Your items' }, { id: 'table', label: 'The table' }]} />

        {tab === 'mine' ? (
          <TabPanel id="mine">
            <ClaimList s={s} b={b} meUserId={meUserId} />
          </TabPanel>
        ) : (
          <TabPanel id="table">
            <Section title={s.expectedDiners !== undefined ? `People · ${joined} of ${s.expectedDiners} joined` : 'People'}>
              <p className="small muted" style={{ textAlign: 'right' }}>
                <button type="button" className="link-btn" onClick={() => { setExpected.reset(); setSizing(s.expectedDiners ?? Math.max(2, joined)); }}>
                  {s.expectedDiners !== undefined ? 'Change number' : 'How many eating?'}
                </button>
              </p>
              <Box>
                <RowButton
                  onClick={() => startTransition(() => setTab('mine'))}
                  action="Your items:"
                  lead={<Avatar name={me?.displayName || 'You'} you />}
                  title="You"
                  sub={myItems.length > 0 ? myItems.join(', ') : 'Claim your items'}
                  end={<Pulse value={myOwed}><span data-testid="lead-share">{formatGBP(myOwed)}</span></Pulse>}
                />
                {guests.length === 0 ? (
                  <Row title="Nobody’s joined yet" sub="Show them the QR code." muted />
                ) : guests.map((p) => (
                  <PersonRow key={p.userId} p={p} owed={owedFor(s, b, p)} busy={confirm.isPending} onConfirm={(paymentId) => confirm.mutate(paymentId)} />
                ))}
              </Box>
              {confirm.isError ? <Notice tone="error">{confirm.error.message}</Notice> : null}
            </Section>

            {everyoneHere && left.length > 0 ? (
              <Notice tone="warn" title="Everyone’s here">{formatGBP(leftWithService)} still not claimed.</Notice>
            ) : null}
            <Box>
              {left.length > 0 ? (
                <RowButton onClick={() => setLeftOpen(true)} title={`Not claimed · ${left.length} ${left.length === 1 ? 'item' : 'items'}`} end={formatGBP(leftWithService)} chevron />
              ) : null}
              <RowLink href={`/session/${s.sessionId}/summary`} title="Full summary" />
            </Box>

            <Button tone="text" className="btn--text-danger" onClick={() => setBinning(true)} style={{ alignSelf: 'flex-start', width: 'auto', padding: 0 }}>Delete this bill</Button>
          </TabPanel>
        )}
      </Page>
      {tab === 'mine' ? (
        <ActionBar stack>
          <div className="actionbar__total">
            <span className="muted">{`Your share${rate > 0 ? ' incl. service' : ''}`}</span>
            <Pulse value={myOwed}><b data-testid="your-share">{formatGBP(myOwed)}</b></Pulse>
          </div>
          <Button onClick={() => startTransition(() => setTab('table'))}>Done</Button>
        </ActionBar>
      ) : (
        <ActionBar>
          <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
          <Button grow onClick={() => setClosing(true)}>Close bill</Button>
        </ActionBar>
      )}

      {leftOpen ? <NotClaimedSheet s={s} rows={left} meUserId={meUserId} onClose={() => startTransition(() => setLeftOpen(false))} /> : null}
      {sizing !== null ? (
        <PartySizeSheet
          n={sizing}
          min={2}
          busy={setExpected.isPending}
          error={setExpected.error?.message}
          canClear={s.expectedDiners !== undefined}
          onChange={setSizing}
          onCancel={() => startTransition(() => setSizing(null))}
          onOk={(expectedDiners) => setExpected.mutate({ expectedDiners }, { onSuccess: () => startTransition(() => setSizing(null)) })}
        />
      ) : null}
      {closing ? (
        <Confirm
          title="Close the bill?"
          body={giveBack ?? ([
            leftPence > 0 ? `Nobody claimed ${formatGBP(leftWithService)}. It goes on you.` : null,
            toCome > 0 ? `${formatGBP(toCome)} still to collect. People can still pay.` : null,
            holdNote,
          ].filter(Boolean).join(' ') || 'Everyone has paid.')}
          ok="Close bill"
          busy={close.isPending}
          error={close.error?.message}
          onOk={() => close.mutate(undefined, { onSuccess: () => startTransition(() => setClosing(false)) })}
          onCancel={() => startTransition(() => setClosing(false))}
        />
      ) : null}
      {binning ? (
        <Confirm
          title="Delete this bill?"
          body={guests.length > 0 ? `${guests.length} ${guests.length === 1 ? 'person loses' : 'people lose'} their picks. This can’t be undone.` : giveBack ?? 'This can’t be undone.'}
          ok="Delete bill"
          danger
          busy={abandon.isPending}
          error={abandon.error?.message}
          onOk={() => abandon.mutate(undefined, { onSuccess: () => router.replace('/') })}
          onCancel={() => startTransition(() => setBinning(false))}
        />
      ) : null}
    </>
  );
}

/** What's still open on a line: unclaimed portions, or a split's open spots. */
function openPence(r: ClaimRow): number {
  const share = r.share;
  if (share) {
    const price = splitPricePence(r.item, share);
    const taken = share.userIds.reduce((acc, u) => acc + sharePence(price, share.userIds, share.ways, u), 0);
    return Math.max(0, price - taken);
  }
  return r.item.unitPricePence * r.left;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * L4.2's Not claimed sheet: Claim takes a line (every portion left of it)
 * onto the lead's share; a split's open spot is joined. The row slides out
 * and the list closes up. Anything left goes on the lead at close anyway.
 */
function NotClaimedSheet({ s, rows, meUserId, onClose }: { s: Session; rows: ClaimRow[]; meUserId: string; onClose: () => void }) {
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const [leaving, setLeaving] = useState<string | null>(null);
  const me = s.participants.find((p) => p.userId === meUserId);
  const take = (r: ClaimRow) => {
    if (!me || leaving) return;
    setLeaving(r.key);
    const last = rows.length === 1;
    const done = { onSuccess: () => { if (last) onClose(); }, onSettled: () => setLeaving(null) };
    setTimeout(() => {
      if (r.share) addShare.mutate({ itemId: r.item.itemId }, done);
      else setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, ...Array<string>(r.left).fill(r.item.itemId)] }, done);
    }, reducedMotion() ? 0 : 280);
  };
  const err = setClaims.error?.message ?? addShare.error?.message;
  return (
    <Dialog id="left-t" title="Not claimed" onClose={onClose} actions={<Button tone="secondary" onClick={onClose}>Close</Button>}>
      <Box>
        {rows.map((r) => (
          <div key={r.key} className={`claim${leaving === r.key ? ' leaving' : ''}`}>
            <span className="row__main">
              <span className="row__title">{r.kind === 'multi' && r.left > 1 ? `${r.left} × ${r.item.name}` : r.kind === 'share' && r.count > 1 ? `${r.count} × ${r.item.name}` : r.item.name}</span>
              <span className="row__sub">{formatGBP(openPence(r))}</span>
            </span>
            <Button tone="secondary" small className="claim__btn" disabled={!!leaving} onClick={() => take(r)} aria-label={`Claim ${r.item.name}`}>Claim</Button>
          </div>
        ))}
      </Box>
      <p className="small muted">Anything left goes on yours when you close.</p>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </Dialog>
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
  // The guests' platform fee is on top of the bill, so it isn't taken off the lead's part.
  const yourPart = Math.max(0, b.totalPence - guests.reduce((acc, p) => acc + owedFor(s, b, p) - projectFeePence(s, b, p.userId), 0));
  const unclaimed = itemStatuses(s, b, s.creatorUserId).filter((x) => x.left > 0);
  const spent = useSpent(s.sessionId);
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub="Bill closed" aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={false} />} />
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
        {unclaimed.length > 0 ? (
          <Section title="Nobody claimed these">
            <Box>{unclaimed.map(({ item, left }) => (
              <Row key={item.itemId} title={left > 1 ? `${item.name} × ${left}` : item.name} end={formatGBP(item.unitPricePence * left)} />
            ))}</Box>
          </Section>
        ) : null}
        {spent.fee ? (
          <Section title="Platform fee">
            {spent.fee.kind === 'hold' ? (
              <Box>
                {spent.fee.capturedAt
                  ? <Row title="Taken from your hold" sub="Your guests pay it back" end={formatGBP(spent.fee.capturedPence ?? 0)} />
                  : <Row title={spent.fee.releasedAt ? 'Hold released' : 'Hold on your card'} end={formatGBP(spent.fee.amountPence)} />}
              </Box>
            ) : (
              <Box><Row title={spent.fee.refundedAt ? 'Refunded' : 'Paid when you shared'} end={formatGBP(spent.fee.amountPence)} /></Box>
            )}
          </Section>
        ) : spent.credit?.returnedAt ? (
          <Section title="Platform fee">
            <Box><Row title="Credit given back" end="1 credit" /></Box>
          </Section>
        ) : null}
        <Totals>
          <TotalLine k="Bill" v={formatGBP(b.totalPence)} />
          <TotalLine tone="total" k="Your part" v={formatGBP(yourPart)} />
        </Totals>
        <Box><RowLink href={`/session/${s.sessionId}/summary`} title="Full summary" /></Box>
      </Page>
      <ActionBar><Button grow href="/" replace>Done</Button></ActionBar>
    </>
  );
}

/** The platform fee or credit that paid for sharing this session, if any. */
export function useSpent(sessionId: string, enabled = true) {
  const billing = useMyBilling({ enabled: enabled && !!STRIPE_PUBLISHABLE_KEY });
  const data = enabled ? billing.data : null;
  return {
    fee: data?.fees.find((f) => f.sessionId === sessionId),
    credit: data?.credits.find((c) => c.sessionId === sessionId),
  };
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
