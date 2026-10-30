'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Check, FileText, Minus, MoreHorizontal, Plus } from 'lucide-react';
import { ApiError, type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import {
  useAbandonSession, useAddShare, useRemoveShare, useSession, useSetClaims, useSetReady, useShareSession,
} from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { extrasRate as billExtrasRate, projectOwedPence, projectSubtotalPence } from '@gdp/core/lib/owed';
import type { PayoutAccount } from '@gdp/core/lib/payoutAccount';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { useScreenTitle } from '@/lib/screen';
import { BillImageModal } from '@/components/BillImageModal';
import { ConfirmDialog } from '@/components/Dialog';
import { DinerRow } from '@/components/DinerRow';
import { JoinQr, useJoinUrl } from '@/components/JoinQr';
import { PaymentDetailsReceipt } from '@/components/PaymentDetailsReceipt';
import {
  BillTotals, BodyText, Button, CenterSpinner, Claim, DisplayText, HeroAmount, LinkButton, Mini, Notice,
  Receipt, ReceiptItem, Rule, SharerStack, Spinner, TotalsRow, type ClaimState,
} from '@/components/ui';

type Participant = components['schemas']['Participant'];
type Bill = components['schemas']['Bill'];
type Session = components['schemas']['Session'];
type BillItem = components['schemas']['BillItem'];

export default function SessionPage() {
  return (
    <Suspense fallback={<CenterSpinner />}>
      <SessionScreen />
    </Suspense>
  );
}

function SessionScreen() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId);
  useScreenTitle(bill.data?.venue?.name ?? null);

  if (session.isPending || (session.isSuccess && bill.isPending) || me.isPending) return <CenterSpinner />;
  if (session.isError) return <ErrorView message={session.error.message} />;
  if (bill.isError) return <ErrorView message={bill.error.message} />;
  const s = session.data;
  const b = bill.data;
  if (!s || !b || !me.data) return null;
  const meId = me.data.userId;
  const isCreator = meId === s.creatorUserId;

  switch (s.status) {
    case 'abandoned': return <AbandonedLayout s={s} isCreator={isCreator} />;
    case 'setup': return <SetupLayout s={s} b={b} sessionId={id} />;
    case 'settled': return <SettledLayout s={s} b={b} meUserId={meId} isCreator={isCreator} />;
    case 'paying': return <PayingLayout s={s} b={b} meUserId={meId} isCreator={isCreator} />;
    default: return <ClaimingLayout s={s} b={b} meUserId={meId} isCreator={isCreator} sessionId={id} />;
  }
}

/* ============================ setup ============================ */

function SetupLayout({ s, b, sessionId }: { s: Session; b: Bill; sessionId: string }) {
  const router = useRouter();
  const share = useShareSession(sessionId);
  const abandon = useAbandonSession(sessionId);
  const payout = usePayoutAccount();
  const [imageOpen, setImageOpen] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);

  const onOpen = () => {
    if (!payout.data) {
      router.push(`/payout-account?returnTo=${encodeURIComponent(`/session/${sessionId}`)}`);
      return;
    }
    share.mutate(undefined, { onSuccess: () => router.push(`/session/${sessionId}/share`) });
  };

  return (
    <div className="screen stack">
      <VenueHead bill={b} onViewBill={() => setImageOpen(true)} />
      <div className="stack gap-base mt-base">
        <Mini>your session</Mini>
        <DisplayText size="md" as="h2">Ready to share?</DisplayText>
        <BodyText>Open it up — diners join with a QR code or 6-digit code. You can still tweak the bill after.</BodyText>
        <Button disabled={share.isPending} onClick={onOpen}>{share.isPending ? <Spinner /> : 'Share with the table →'}</Button>
        {share.isError ? <Notice title="Couldn't open the session." detail={share.error.message} /> : null}
      </div>
      <BillSummary b={b} onEdit={() => router.push(`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`)} onViewPhoto={() => setImageOpen(true)} />
      <div className="danger-wrap mt-xl">
        <Button variant="ghost" disabled={abandon.isPending} onClick={() => setConfirmingAbandon(true)}>
          {abandon.isPending ? 'Abandoning…' : 'Abandon session'}
        </Button>
      </div>
      <BillImageModal billId={s.billId} visible={imageOpen} onClose={() => setImageOpen(false)} />
      <ConfirmDialog
        visible={confirmingAbandon}
        title="Bin the bill?"
        body={abandonBody(s.participants.length)}
        confirmLabel="Bin it"
        destructive
        onCancel={() => setConfirmingAbandon(false)}
        onConfirm={() => { setConfirmingAbandon(false); abandon.mutate(undefined, { onSuccess: () => router.replace('/') }); }}
      />
    </div>
  );
}

/* =========================== claiming =========================== */

function ClaimingLayout({ s, b, meUserId, isCreator, sessionId }: { s: Session; b: Bill; meUserId: string; isCreator: boolean; sessionId: string }) {
  const router = useRouter();
  const setClaims = useSetClaims(sessionId);
  const setReady = useSetReady(sessionId);
  const abandon = useAbandonSession(sessionId);
  const addShare = useAddShare(sessionId);
  const removeShare = useRemoveShare(sessionId);
  const leadPayout = usePayoutAccount();
  const showQr = useSearchParams().get('showQr');
  const [imageOpen, setImageOpen] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const [confirmingReady, setConfirmingReady] = useState(false);
  // Lands open straight after confirm-bill so the lead can show the table.
  const [qrOpen, setQrOpen] = useState(isCreator && showQr === '1');

  const myParticipant = s.participants.find((p) => p.userId === meUserId);
  const counts = useClaimCounts(s, meUserId);
  const totalUnits = b.items.reduce((sum, it) => sum + it.quantity, 0);
  const totalClaimed = s.participants.reduce((acc, p) => acc + p.claimedItemIds.length, 0);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const readyGuests = guests.filter((p) => p.readyToLock);

  // Running total — same maths the server uses (see @gdp/core/lib/owed).
  const mySubtotalPence = projectSubtotalPence(s, b, meUserId);
  const extrasRate = billExtrasRate(b);
  const myProjectedPence = Math.round(mySubtotalPence * (1 + extrasRate));

  const claimOne = (item: BillItem) => {
    if (!myParticipant) return;
    const remaining = item.quantity - (counts.mine.get(item.itemId) ?? 0) - (counts.others.get(item.itemId) ?? 0);
    if (remaining <= 0) return;
    setClaims.mutate({ claimedItemIds: [...myParticipant.claimedItemIds, item.itemId] });
  };
  const unclaimOne = (itemId: string) => {
    if (!myParticipant) return;
    const next = [...myParticipant.claimedItemIds];
    const idx = next.lastIndexOf(itemId);
    if (idx < 0) return;
    next.splice(idx, 1);
    setClaims.mutate({ claimedItemIds: next });
  };
  const toggleShare = (itemId: string) => {
    const inShare = !!s.shares?.find((sh) => sh.itemId === itemId)?.userIds.includes(meUserId);
    if (inShare) removeShare.mutate({ itemId });
    else addShare.mutate({ itemId });
  };

  const picking = !myParticipant?.readyToLock || isCreator;

  const stickyHint = (() => {
    const paidCount = guests.filter((p) => p.payment.status === 'succeeded' || p.payment.status === 'pending').length;
    if (guests.length === 0) return 'waiting for diners to join';
    const unclaimed = totalUnits - totalClaimed;
    if (unclaimed > 0) return `${unclaimed} item${unclaimed === 1 ? '' : 's'} not claimed yet · ${paidCount}/${guests.length} paid`;
    return `${paidCount} of ${guests.length} paid`;
  })();

  return (
    <>
      <div className={!isCreator && myParticipant ? 'screen screen--sticky stack' : 'screen stack'} style={isCreator ? { paddingBottom: 110 } : undefined}>
        <VenueHead
          bill={b}
          onViewBill={() => setImageOpen(true)}
          titleOverride={isCreator ? 'Picking items' : 'Pick your items'}
          counter={isCreator && guests.length > 0 ? `${readyGuests.length}/${guests.length} ready` : undefined}
        />

        {!isCreator && myParticipant?.readyToLock ? (
          <GuestReadyPreview sessionId={sessionId} leadName={leadName(s)} owedPence={myParticipant.owedPence ?? myProjectedPence} />
        ) : null}

        {isCreator && s.joinCode ? (
          qrOpen ? (
            <LeadQrPanel joinCode={s.joinCode} payout={leadPayout.data ?? null} onMinimise={() => setQrOpen(false)} />
          ) : (
            <div className="mt-base"><Button variant="ghost" onClick={() => setQrOpen(true)}>Show QR & join code</Button></div>
          )
        ) : null}

        {picking ? (
          <>
            <Receipt list className="mt-base">
              {b.items.map((it) => {
                const shareUserIds = s.shares?.find((x) => x.itemId === it.itemId)?.userIds ?? [];
                const sharers = shareUserIds.map((uid) => s.participants.find((p) => p.userId === uid)).filter((p): p is Participant => !!p);
                return (
                  <ClaimRow
                    key={it.itemId}
                    item={it}
                    myCount={counts.mine.get(it.itemId) ?? 0}
                    othersCount={counts.others.get(it.itemId) ?? 0}
                    claimers={counts.othersByItem.get(it.itemId) ?? []}
                    sharers={sharers}
                    meUserId={meUserId}
                    isCreator={isCreator}
                    locked={!isCreator && !!myParticipant?.readyToLock}
                    onClaim={() => claimOne(it)}
                    onUnclaim={() => unclaimOne(it.itemId)}
                    onToggleShare={() => toggleShare(it.itemId)}
                  />
                );
              })}
            </Receipt>
            <Rule />
            {myParticipant ? (
              <div className="running-total">
                <div>
                  <Mini>your share so far</Mini>
                  <div className="running-total__v">{formatGBP(mySubtotalPence)}</div>
                </div>
                {extrasRate > 0 && mySubtotalPence > 0 ? (
                  <div style={{ textAlign: 'right' }}>
                    <Mini>≈ with service</Mini>
                    <div className="running-total__hint">{formatGBP(myProjectedPence)}</div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        <div className="stack gap-sm mt-md">
          {setClaims.isError ? <Notice title="Couldn't update claims." detail={setClaims.error.message} /> : null}
          {setReady.isError ? <Notice title="Couldn't update status." detail={setReady.error.message} /> : null}
          {addShare.isError ? <Notice title="Couldn't join the share." detail={shareErrorMessage(addShare.error)} /> : null}
          {removeShare.isError ? <Notice title="Couldn't leave the share." detail={removeShare.error.message} /> : null}
        </div>

        {isCreator ? (
          <section className="stack gap-xs mt-lg">
            <Mini>diners</Mini>
            <div className="diners">
              {s.participants.map((p) => (
                <DinerRow key={p.userId} p={p} isMe={p.userId === meUserId} isLead={p.userId === s.creatorUserId}
                  variant="claiming" billExtrasRate={extrasRate} items={b.items} shares={s.shares} />
              ))}
            </div>
          </section>
        ) : null}

        {isCreator ? (
          <div className="stack gap-sm mt-lg">
            {s.joinCode ? <Button variant="ghost" href={`/session/${s.sessionId}/share`}>Show join code</Button> : null}
            <Button variant="ghost" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
            <div className="danger-wrap">
              <Button variant="ghost" disabled={abandon.isPending} onClick={() => setConfirmingAbandon(true)}>
                {abandon.isPending ? 'Abandoning…' : 'Abandon session'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="sticky-bar">
        <div className="sticky-bar__inner">
          {!isCreator && myParticipant ? (
            myParticipant.readyToLock ? (
              <Button variant="ghost" disabled={setReady.isPending} onClick={() => setReady.mutate({ ready: false })}>
                {setReady.isPending ? 'Reopening…' : 'Edit my picks'}
              </Button>
            ) : (
              <Button disabled={setReady.isPending} onClick={() => setConfirmingReady(true)}>
                {setReady.isPending ? <Spinner /> : "I'm done →"}
              </Button>
            )
          ) : null}
          {isCreator ? <Mini className="sticky-bar__hint">{stickyHint}</Mini> : null}
        </div>
      </div>

      <BillImageModal billId={s.billId} visible={imageOpen} onClose={() => setImageOpen(false)} />
      <ConfirmDialog
        visible={confirmingAbandon}
        title="Bin the bill?"
        body={abandonBody(s.participants.length)}
        confirmLabel="Bin it"
        destructive
        onCancel={() => setConfirmingAbandon(false)}
        onConfirm={() => { setConfirmingAbandon(false); abandon.mutate(undefined, { onSuccess: () => router.replace('/') }); }}
      />
      <ConfirmDialog
        visible={confirmingReady}
        title="All done picking?"
        body="You can still edit your picks until the host splits the bill. If they split before you reopen, your picks are final."
        confirmLabel="Yes, I'm done"
        cancelLabel="Keep picking"
        onCancel={() => setConfirmingReady(false)}
        onConfirm={() => { setConfirmingReady(false); setReady.mutate({ ready: true }); }}
      />
    </>
  );
}

function ClaimRow({ item, myCount, othersCount, claimers, sharers, meUserId, isCreator, locked, onClaim, onUnclaim, onToggleShare }: {
  item: BillItem; myCount: number; othersCount: number; claimers: Participant[]; sharers: Participant[];
  meUserId: string; isCreator: boolean; locked: boolean; onClaim: () => void; onUnclaim: () => void; onToggleShare: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const remaining = item.quantity - myCount - othersCount;
  const isUnclaimed = myCount === 0 && othersCount === 0;
  const isShared = sharers.length > 0;
  const inShare = sharers.some((p) => p.userId === meUserId);

  const sortedSharers = isShared ? [...sharers].sort((a, b) => a.userId.localeCompare(b.userId)) : [];
  const baseSharePence = isShared ? Math.floor(item.unitPricePence / sharers.length) : 0;
  const shareRemainder = isShared ? item.unitPricePence - baseSharePence * sharers.length : 0;
  const mySharePence = inShare ? baseSharePence + (meUserId === sortedSharers[0]?.userId ? shareRemainder : 0) : baseSharePence;

  // Sharing is for single-unit items nobody has claimed yet (ADR-0006).
  const canShare = !locked && item.quantity === 1 && isUnclaimed && !isShared;
  const canClaim = !locked && !isShared && remaining > 0;

  const state: ClaimState = myCount > 0 || inShare ? 'mine' : isShared ? 'joinable' : remaining === 0 ? 'taken' : 'default';

  useEffect(() => { if (state !== 'default' && menuOpen) setMenuOpen(false); }, [state, menuOpen]);

  const meta = (() => {
    if (isShared) {
      if (!isCreator) return 'shared';
      return sharers.map((p) => (p.userId === meUserId ? `${p.displayName.split(' ')[0]?.toLowerCase()} (you)` : p.displayName.toLowerCase())).join(', ');
    }
    if (myCount > 0) {
      if (item.quantity > 1) {
        if (myCount === item.quantity) return 'all yours';
        if (remaining === 0) return `${myCount} of ${item.quantity} yours`;
        return `${myCount} of ${item.quantity} yours · ${remaining} left`;
      }
      return '';
    }
    if (remaining === 0 && claimers.length > 0) {
      if (item.quantity > 1) return 'all claimed';
      if (!isCreator) return 'taken';
      return claimers.map((p) => p.displayName.split(' ')[0]?.toLowerCase()).join(', ');
    }
    if (item.quantity > 1) return `${remaining} left · ${formatGBP(item.unitPricePence)} each`;
    return '';
  })();

  const priceLabel = isShared
    ? formatGBP(inShare ? mySharePence : baseSharePence)
    : myCount > 0 && item.quantity > 1
      ? formatGBP(item.unitPricePence * myCount)
      : formatGBP(item.unitPricePence * item.quantity);

  // Tapping a "mine" row drops one / leaves the share; tapping a joinable
  // row joins the share. Same as the native row.
  const handlePress = () => {
    if (locked) return;
    if (isShared) onToggleShare();
    else if (myCount > 0) onUnclaim();
    else if (canClaim) onClaim();
  };

  const showAvatars = isShared && (state === 'joinable' || state === 'mine');
  const subContent = showAvatars ? (
    <div className={state === 'joinable' ? 'claim__sub claim__sub--accent' : 'claim__sub'}>
      <SharerStack sharers={sharers} />
      <span>
        {state === 'joinable'
          ? sharers.length > 1 ? `${sharers.length} sharing · tap to join` : 'shared · tap to join'
          : `splitting ${sharers.length} ways`}
      </span>
    </div>
  ) : undefined;

  const right = state === 'taken' ? undefined : (
    <div className="claim__right">
      <span className="num claim__price">{priceLabel}</span>
      <div className="claim__ctl">
        {state === 'mine' ? (
          <IconButton icon="minus" label={inShare ? `Leave the share for ${item.name}` : `Drop one ${item.name}`} onPress={handlePress} />
        ) : null}
        {state === 'joinable' && !locked ? <IconButton icon="plus" label={`Join the share for ${item.name}`} onPress={handlePress} /> : null}
        {!locked && (state === 'default' || (state === 'mine' && !inShare && remaining > 0)) ? (
          <IconButton icon="plus" label={state === 'mine' ? `Claim another ${item.name}` : `Claim ${item.name}`} onPress={onClaim} />
        ) : null}
        {state === 'default' && canShare ? (
          <IconButton icon="more" label={`More options for ${item.name}`} active={menuOpen} onPress={() => setMenuOpen((v) => !v)} />
        ) : null}
      </div>
    </div>
  );

  return (
    <div>
      <Claim
        name={item.quantity > 1 ? `${item.quantity}× ${item.name}` : item.name}
        meta={meta}
        subContent={subContent}
        price={priceLabel}
        state={state}
        onPress={!locked && (state === 'mine' || state === 'joinable') ? handlePress : undefined}
        right={right}
      />
      {canShare && menuOpen ? (
        <div className="claim-menu">
          <Button variant="quiet" onClick={() => { setMenuOpen(false); onToggleShare(); }}>Split this</Button>
        </div>
      ) : null}
    </div>
  );
}

function IconButton({ icon, onPress, label, active }: { icon: 'plus' | 'minus' | 'more'; onPress: () => void; label: string; active?: boolean }) {
  return (
    <button type="button" className={active ? 'icon-btn icon-btn--active' : 'icon-btn'} aria-label={label} aria-expanded={icon === 'more' ? !!active : undefined}
      onClick={(e) => { e.stopPropagation(); onPress(); }}>
      {icon === 'plus' ? <Plus size={14} /> : icon === 'minus' ? <Minus size={14} /> : <MoreHorizontal size={14} />}
    </button>
  );
}

function LeadQrPanel({ joinCode, payout, onMinimise }: { joinCode: string; payout: PayoutAccount | null; onMinimise: () => void }) {
  const joinUrl = useJoinUrl(joinCode, payout);
  return (
    <div className="stack gap-sm mt-base">
      <Receipt>
        <div className="stack gap-sm" style={{ alignItems: 'center', padding: '8px 0' }}>
          <Mini>show this to the table</Mini>
          <JoinQr url={joinUrl} size={200} />
          <span className="join-code mt-xs" style={{ fontSize: 28 }}>{joinCode}</span>
          <Mini>or share this code</Mini>
        </div>
      </Receipt>
      <Button variant="ghost" onClick={onMinimise}>Hide · start claiming</Button>
    </div>
  );
}

function GuestReadyPreview({ sessionId, leadName: lead, owedPence }: { sessionId: string; leadName: string; owedPence: number }) {
  const firstName = lead.split(' ')[0]?.toLowerCase() ?? 'the host';
  return (
    <div className="stack gap-sm mt-base">
      <HeroAmount caption={`pay ${lead.toLowerCase()}`} amount={formatGBP(owedPence)} aside={`Straight to ${firstName}'s bank. We never touch your money.`} />
      <Button href={`/session/${sessionId}/pay`}>Sort my payment →</Button>
    </div>
  );
}

/* ============================ paying ============================ */

function PayingLayout({ s, b, meUserId, isCreator }: { s: Session; b: Bill; meUserId: string; isCreator: boolean }) {
  const [imageOpen, setImageOpen] = useState(false);
  const totalPence = s.participants.reduce((acc, p) => acc + owedFor(s, b, p), 0);
  const collected = s.participants.reduce((acc, p) => (p.payment.status === 'succeeded' || p.payment.status === 'self_paid' ? acc + owedFor(s, b, p) : acc), 0);
  const outstanding = totalPence - collected;
  return (
    <div className="screen stack">
      <VenueHead bill={b} titleOverride={isCreator ? 'Collecting payments' : 'Pay your share'} onViewBill={() => setImageOpen(true)} />
      {isCreator ? (
        <Receipt className="mt-sm">
          <TotalsRow label="total" value={formatGBP(totalPence)} />
          <TotalsRow label="collected" value={formatGBP(collected)} valueColor={collected > 0 ? 'var(--ok)' : 'var(--mute)'} />
          <TotalsRow label="outstanding" value={formatGBP(outstanding)} valueColor={outstanding > 0 ? 'var(--warn)' : 'var(--mute)'} />
        </Receipt>
      ) : (
        <GuestPayHero s={s} b={b} meUserId={meUserId} />
      )}
      {isCreator ? (
        <section className="stack gap-xs mt-lg">
          <Mini>diners</Mini>
          <div className="diners">
            {s.participants.map((p) => (
              <DinerRow key={p.userId} p={p} isMe={p.userId === meUserId} isLead={p.userId === s.creatorUserId} variant="paying" fallbackOwedPence={owedFor(s, b, p)} />
            ))}
          </div>
        </section>
      ) : null}
      <div className="stack gap-sm mt-lg">
        {isCreator ? <Button href={`/session/${s.sessionId}/pay`}>Open payments →</Button> : null}
        <Button variant="ghost" onClick={() => setImageOpen(true)}>View original bill</Button>
      </div>
      <BillImageModal billId={s.billId} visible={imageOpen} onClose={() => setImageOpen(false)} />
    </div>
  );
}

function GuestPayHero({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const me = s.participants.find((p) => p.userId === meUserId);
  const lead = s.participants.find((p) => p.userId === s.creatorUserId);
  const sessionPayout = useSessionPayout(s.sessionId);
  if (!me) return null;
  const firstName = lead?.displayName.split(' ')[0]?.toLowerCase() ?? 'the host';
  return (
    <div className="stack gap-sm mt-base">
      <HeroAmount
        caption={`pay ${lead?.displayName.toLowerCase() ?? 'the host'}`}
        amount={formatGBP(owedFor(s, b, me))}
        aside={`Straight to ${firstName}'s bank. We never touch your money.`}
      />
      {sessionPayout.data ? <PaymentDetailsReceipt bankDetails={sessionPayout.data} amountPence={owedFor(s, b, me)} /> : null}
      <Button href={`/session/${s.sessionId}/pay`}>Continue to pay →</Button>
    </div>
  );
}

/* ============================ settled ============================ */

function SettledLayout({ s, b, meUserId, isCreator }: { s: Session; b: Bill; meUserId: string; isCreator: boolean }) {
  const [imageOpen, setImageOpen] = useState(false);
  const totalPence = s.participants.reduce((acc, p) => acc + owedFor(s, b, p), 0);
  const myParticipant = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = host?.displayName.split(' ')[0]?.toLowerCase() ?? 'the host';
  return (
    <div className="screen stack">
      <VenueHead bill={b} onViewBill={() => setImageOpen(true)} titleOverride="Settled" />
      {isCreator ? (
        <>
          <div className="mt-sm">
            <DisplayText size="md" as="p" className="rise-in">{formatGBP(totalPence)}</DisplayText>
            <BodyText className="mt-xs">{s.participants.length} diner{s.participants.length === 1 ? '' : 's'} paid up.</BodyText>
          </div>
          <Receipt className="mt-base">
            {b.items.map((it) => (
              <ReceiptItem key={it.itemId} name={it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name} price={formatGBP(it.unitPricePence * it.quantity)} />
            ))}
            <BillTotals subtotalPence={b.subtotalPence} servicePence={b.serviceChargePence} taxPence={b.taxPence} totalPence={b.totalPence} />
          </Receipt>
          <div className="mt-lg"><Button href="/capture" replace>Start another bill →</Button></div>
        </>
      ) : (
        <GuestSettledBody b={b} myParticipant={myParticipant} myOwed={myParticipant ? owedFor(s, b, myParticipant) : 0} hostFirst={hostFirst} />
      )}
      {isCreator ? (
        <section className="stack gap-xs mt-lg">
          <Mini>diners</Mini>
          <div className="diners">
            {s.participants.map((p) => (
              <DinerRow key={p.userId} p={p} isMe={p.userId === meUserId} isLead={p.userId === s.creatorUserId} variant="settled" fallbackOwedPence={owedFor(s, b, p)} />
            ))}
          </div>
        </section>
      ) : null}
      <div className="stack gap-sm mt-lg">
        <Button variant="ghost" onClick={() => setImageOpen(true)}>View original bill</Button>
        <Button variant={isCreator ? 'ghost' : 'accent'} href="/" replace>Back to home</Button>
      </div>
      <BillImageModal billId={s.billId} visible={imageOpen} onClose={() => setImageOpen(false)} />
    </div>
  );
}

function GuestSettledBody({ b, myParticipant, myOwed, hostFirst }: { b: Bill; myParticipant?: Participant; myOwed: number; hostFirst: string }) {
  const paidAtIso = myParticipant?.payment.status === 'succeeded' ? myParticipant.payment.paidAt : null;
  const paidAt = paidAtIso ? new Date(paidAtIso) : null;
  const time = paidAt ? `${String(paidAt.getHours()).padStart(2, '0')}:${String(paidAt.getMinutes()).padStart(2, '0')}` : null;
  const claimed = (myParticipant?.claimedItemIds ?? []).map((id) => b.items.find((it) => it.itemId === id)).filter((it): it is BillItem => !!it);
  const shared = (myParticipant?.sharedItemIds ?? []).map((id) => b.items.find((it) => it.itemId === id)).filter((it): it is BillItem => !!it);
  return (
    <>
      <div className="stack gap-sm mt-xl" style={{ alignItems: 'center' }}>
        <span className="check-disc rise-in" style={{ width: 72, height: 72 }}><Check size={40} /></span>
        <Mini className="mt-xs">you paid</Mini>
        <div className="big-amount rise-in rise-in--late">{formatGBP(myOwed)}</div>
        <BodyText className="t-center">to {hostFirst}{time ? ` · ${time}` : ''}</BodyText>
      </div>
      {claimed.length + shared.length > 0 ? (
        <section className="stack gap-xs mt-xl">
          <Mini>what you had</Mini>
          <Receipt>
            {claimed.map((it, i) => (
              <ReceiptItem key={`${it.itemId}-${i}`} name={it.name} price={formatGBP(it.unitPricePence)} />
            ))}
            {shared.map((it) => <ReceiptItem key={it.itemId} name={it.name} price="shared" />)}
            <div className="totals"><TotalsRow label="YOUR TOTAL" value={formatGBP(myOwed)} emphasis="strong" /></div>
          </Receipt>
        </section>
      ) : null}
    </>
  );
}

/* ============================ ended ============================ */

function AbandonedLayout({ s, isCreator }: { s: Session; isCreator: boolean }) {
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  return (
    <div className="center" style={{ minHeight: '70vh' }}>
      <Mini>ended</Mini>
      <DisplayText size="md" as="h2" className="t-center">This session has ended.</DisplayText>
      <BodyText className="t-center">
        {isCreator
          ? 'You abandoned this session. The bill is unlocked, so you can start a new one from the same receipt.'
          : `${host?.displayName ?? 'The host'} ended this session. The bill won't be split here.`}
      </BodyText>
      {!isCreator ? <Mini className="t-center">if you weren&apos;t expecting this · speak to {host?.displayName.toLowerCase() ?? 'the host'}</Mini> : null}
      <div style={{ width: '100%', maxWidth: 360 }} className="mt-base"><Button href="/" replace>Back to home →</Button></div>
    </div>
  );
}

/* ============================ shared bits ============================ */

function VenueHead({ bill, onViewBill, counter, titleOverride }: { bill: Bill; onViewBill?: () => void; counter?: string; titleOverride?: string }) {
  const heading = titleOverride ?? bill.venue?.name;
  const addr = bill.venue?.address?.split(',')[0]?.trim();
  const caption = [titleOverride ? bill.venue?.name : null, addr, `${formatGBP(bill.totalPence)} total`].filter(Boolean).join(' · ');
  return (
    <div className="venue-head">
      <div className="stack gap-xs" style={{ flex: 1, minWidth: 0 }}>
        {heading ? <DisplayText size="md" as="h2">{heading}</DisplayText> : null}
        {caption ? <BodyText>{caption}</BodyText> : null}
      </div>
      <div className="venue-head__side">
        {counter ? <Mini>{counter}</Mini> : null}
        {onViewBill ? (
          <button type="button" className="icon-round" aria-label="View the original bill" onClick={onViewBill}><FileText size={16} /></button>
        ) : null}
      </div>
    </div>
  );
}

function BillSummary({ b, onEdit, onViewPhoto }: { b: Bill; onEdit: () => void; onViewPhoto: () => void }) {
  const preview = b.items.slice(0, 4);
  const remaining = b.items.length - preview.length;
  return (
    <section className="stack gap-sm mt-lg">
      <Mini>what you&apos;re sharing</Mini>
      <Receipt>
        {preview.map((it) => (
          <ReceiptItem key={it.itemId} name={it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name} price={formatGBP(it.unitPricePence * it.quantity)} />
        ))}
        {remaining > 0 ? (
          <ReceiptItem name={`+ ${remaining} more`} price={formatGBP(b.items.slice(4).reduce((acc, it) => acc + it.unitPricePence * it.quantity, 0))} />
        ) : null}
        <div className="totals"><TotalsRow label="TOTAL" value={formatGBP(b.totalPence)} emphasis="strong" /></div>
      </Receipt>
      <div className="gdp-row" style={{ justifyContent: 'flex-start', gap: 16 }}>
        <LinkButton onClick={onViewPhoto}>view photo</LinkButton>
        <LinkButton onClick={onEdit}>edit bill</LinkButton>
      </div>
    </section>
  );
}

function ErrorView({ message }: { message: string }) {
  return <div className="center"><Notice title="Couldn't load." detail={message} /><Button variant="ghost" href="/">Back to home</Button></div>;
}

function useClaimCounts(s: Session, meUserId: string) {
  return useMemo(() => {
    const mine = new Map<string, number>();
    const others = new Map<string, number>();
    const othersByItem = new Map<string, Participant[]>();
    for (const p of s.participants) {
      const isMe = p.userId === meUserId;
      for (const itemId of p.claimedItemIds) {
        if (isMe) {
          mine.set(itemId, (mine.get(itemId) ?? 0) + 1);
        } else {
          others.set(itemId, (others.get(itemId) ?? 0) + 1);
          const list = othersByItem.get(itemId) ?? [];
          if (!list.some((x) => x.userId === p.userId)) list.push(p);
          othersByItem.set(itemId, list);
        }
      }
    }
    return { mine, others, othersByItem };
  }, [s, meUserId]);
}

/**
 * owedPence is only fixed by lock-claims. Sessions that settle straight
 * from claiming (trust-based payments) never get it, so fall back to the
 * same projection the claim screen showed.
 */
function owedFor(s: Session, b: Bill, p: Participant): number {
  return p.owedPence ?? projectOwedPence(s, b, p.userId);
}

function leadName(s: Session): string {
  return s.participants.find((p) => p.userId === s.creatorUserId)?.displayName ?? 'the host';
}

function abandonBody(participantCount: number): string {
  return participantCount > 1
    ? `${participantCount} diners are in it — they lose access and their claims go with it. No coming back from this.`
    : 'No coming back from this.';
}

function shareErrorMessage(err: ApiError): string {
  if (err.code === 'ITEM_NOT_SHAREABLE') return "Share isn't supported on multi-quantity items yet.";
  if (err.code === 'CLAIM_SHARE_CONFLICT') return 'This item is currently being claimed — ask the claimer to release it before sharing.';
  return err.message;
}
