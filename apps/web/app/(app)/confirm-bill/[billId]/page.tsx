'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { isFeeRequired, shareSession, useCreateSession, useSession } from '@gdp/core/api/hooks/useSession';
import { useAmendBill } from '@gdp/core/api/hooks/useAmendBill';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { useTableFeeStatus } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { formatGBP } from '@gdp/core/lib/money';
import { RESUMED_PARAM } from '@gdp/core/lib/duplicateRoute';
import {
  ActionBar, BackLink, BillSkeleton, Button, Centre, Notice, Page, PencilIcon, PlusIcon, Receipt, ReceiptLine, TickIcon, Title,
} from '@/components/ui';

type Bill = components['schemas']['Bill'];
type BillItem = components['schemas']['BillItem'];
type DraftItem = { draftId: string; itemId?: string; name: string; unitPricePounds: string; quantity: number; category: BillItem['category']; course?: BillItem['course'] };

const fromBillItem = (it: BillItem, idx: number): DraftItem => ({
  draftId: `existing-${it.itemId}-${idx}`,
  itemId: it.itemId,
  name: it.name,
  unitPricePounds: (it.unitPricePence / 100).toFixed(2),
  quantity: it.quantity,
  category: it.category,
  ...(it.category === 'food' && it.course ? { course: it.course } : {}),
});
const blankItem = (): DraftItem => ({ draftId: `new-${Math.random().toString(36).slice(2, 9)}`, name: '', unitPricePounds: '0.00', quantity: 1, category: 'food' });
const parsePence = (s: string): number => { const n = Number(s); return !Number.isFinite(n) || n < 0 ? 0 : Math.round(n * 100); };
const pounds = (p: number) => (p / 100).toFixed(2);

// "Where was this?" skipped for a bill, in this browser, so it isn't asked again.
const skipKey = (billId: string) => `gdp.venue-skipped.${billId}`;
const venueSkipped = (billId: string): boolean => {
  try { return sessionStorage.getItem(skipKey(billId)) === '1'; } catch { return false; }
};
const skipVenue = (billId: string) => {
  try { sessionStorage.setItem(skipKey(billId), '1'); } catch { /* asked again next time */ }
};

/**
 * The check step (#107), before Review bill: each line the reader was
 * unsure of, one at a time, then the place when the receipt names none.
 * `steps` holds itemIds and 'venue'; fixed when the bill first loads.
 */
type Check = { steps: string[]; notes: Record<string, string>; at: number };

function existingSessionIdFromError(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== 'SESSION_INVALID_STATE') return undefined;
  const d = err.details as { sessionId?: unknown } | undefined;
  return typeof d?.sessionId === 'string' ? d.sessionId : undefined;
}

function BillLoading() {
  return (
    <Page sub>
      <Title title="Check it matches" />
      <div role="status" className="vh">Loading the bill</div>
      <BillSkeleton />
    </Page>
  );
}

export default function ConfirmBillPage() {
  return <Suspense fallback={<BillLoading />}><CheckBill /></Suspense>;
}

/**
 * Review the bill: the scanned lines in a list. Tap a line to fix it;
 * each fix saves when the editor closes. Service and tax edit the same way.
 */
function CheckBill() {
  const { billId } = useParams<{ billId: string }>();
  const params = useSearchParams();
  const sessionId = params.get('sessionId') ?? undefined;
  const isMidSession = !!sessionId;
  // A photo sent before, of a bill the lead had already changed.
  const resumed = !isMidSession && params.get(RESUMED_PARAM) === '1';
  const router = useRouter();
  const queryClient = useQueryClient();
  const bill = useBill(billId);
  const session = useSession(sessionId);
  const amend = useAmendBill(billId ?? '');
  const createSession = useCreateSession();
  const payout = usePayoutAccount();
  // The platform fee is paid on the last step before the QR code. Null = no
  // fee here (Stripe not set up on the API or the web app).
  const fee = useTableFeeStatus(billId, { enabled: !!STRIPE_PUBLISHABLE_KEY && !isMidSession });

  const [items, setItems] = useState<DraftItem[]>([]);
  const [servicePounds, setServicePounds] = useState('0.00');
  const [taxPounds, setTaxPounds] = useState('0.00');
  const [venueName, setVenueName] = useState('');
  // A place the lead picked while the bill was read (#61): its ID and
  // address go with the name, as long as the name isn't changed.
  const [hydrated, setHydrated] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // draftId | 'service' | 'tax' | 'venue'
  const [snapshot, setSnapshot] = useState<DraftItem | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  // *Generate QR code* confirms in place, naming what it uses (#223).
  const [asking, setAsking] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (asking) askRef.current?.focus(); }, [asking]);
  // The photo beside a total that doesn't add up, opened from its notice.
  const [showPhoto, setShowPhoto] = useState(false);
  const photo = useBillImageUrl(billId, !!check || showPhoto);

  useEffect(() => {
    if (bill.data && !hydrated) {
      hydrateFrom(bill.data);
      setHydrated(true);
      // Mid-session the lead is fixing something specific; no check then.
      if (!isMidSession && billId) {
        const unsure = bill.data.items.filter((it) => it.unsure);
        const steps = [
          ...unsure.map((it) => it.itemId),
          ...(!bill.data.venue?.name && !venueSkipped(billId) ? ['venue'] : []),
        ];
        if (steps.length > 0) {
          setCheck({ steps, notes: Object.fromEntries(unsure.map((it) => [it.itemId, it.unsure!])), at: 0 });
          // Holds the autosave until the check is done: it saves once, at the end.
          setEditing('check');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill.data, hydrated]);

  const hydrateFrom = (b: Bill) => {
    setItems(b.items.map(fromBillItem));
    setServicePounds(pounds(b.serviceChargePence));
    setTaxPounds(pounds(b.taxPence));
    setVenueName(b.venue?.name ?? '');
  };

  const subtotalPence = useMemo(() => items.reduce((acc, it) => acc + parsePence(it.unitPricePounds) * it.quantity, 0), [items]);
  const servicePence = parsePence(servicePounds);
  const taxPence = parsePence(taxPounds);
  const totalPence = subtotalPence + servicePence + taxPence;
  // No credit: a £1 hold on the lead's card (#165). Nothing is taken now.
  const feeDue = fee.data?.status === 'unpaid' ? fee.data.amountPence : null;
  // This month's free bill, or a bought credit (#169): sharing spends it.
  const credit = fee.data?.status === 'free' || fee.data?.status === 'credit';
  const creditsLeft = fee.data && 'boughtCredits' in fee.data
    ? (fee.data.status === 'free' ? 1 : 0) + (fee.data.boughtCredits ?? 0)
    : 1;

  const freeCredit = fee.data?.status === 'free';
  // Nothing to spend (no Stripe here, or an exempt lead): straight on.
  const onGenerate = () => {
    if (!payout.isPending && !payout.data) { void onShare(); return; }
    if (feeDue !== null || credit) setAsking(true);
    else void onShare();
  };

  const isDirty = useMemo(() => {
    const b = bill.data;
    if (!b) return false;
    if (b.items.length !== items.length || b.serviceChargePence !== servicePence || b.taxPence !== taxPence) return true;
    if (venueName.trim() && venueName.trim() !== (b.venue?.name ?? '')) return true;
    return items.some((local, i) => {
      const server = b.items[i];
      return !server || local.itemId !== server.itemId || local.name !== server.name ||
        parsePence(local.unitPricePounds) !== server.unitPricePence || local.quantity !== server.quantity;
    });
  }, [bill.data, items, servicePence, taxPence, venueName]);

  // Save as soon as an edit is finished, so nothing is lost on leaving.
  useEffect(() => {
    if (editing !== null || !hydrated || !isDirty || amend.isPending) return;
    void saveDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isDirty, hydrated]);

  const claimsByItemId = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of session.data?.participants ?? []) for (const id of p.claimedItemIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [session.data]);

  const updateItem = (draftId: string, patch: Partial<DraftItem>) => setItems((prev) => prev.map((it) => (it.draftId === draftId ? { ...it, ...patch } : it)));
  const removeItem = (draftId: string) => setItems((prev) => prev.filter((it) => it.draftId !== draftId));
  const startEditing = (it: DraftItem) => { setEditing(it.draftId); setSnapshot(it); };
  const cancelEditing = () => {
    if (snapshot) {
      if (!snapshot.itemId && !snapshot.name.trim()) removeItem(snapshot.draftId);
      else updateItem(snapshot.draftId, snapshot);
    }
    setEditing(null); setSnapshot(null);
  };
  const finishEditing = () => { setEditing(null); setSnapshot(null); };
  const addAndEdit = () => { const it = blankItem(); setItems((prev) => [...prev, it]); startEditing(it); };

  const buildAmendPayload = (venue = venueName) => ({
    items: items.map((it) => ({
      ...(it.itemId ? { itemId: it.itemId } : {}),
      name: it.name.trim() || 'Item',
      unitPricePence: parsePence(it.unitPricePounds),
      quantity: Math.max(1, Math.floor(it.quantity)),
      category: it.category,
      ...(it.category === 'food' && it.course ? { course: it.course } : {}),
    })),
    taxPence,
    serviceChargePence: servicePence,
    ...(venue.trim()
      ? {
          venue: { name: venue.trim() },
        }
      : {}),
  });

  /** Next check, or save once (clearing the reader's notes) and show Review bill. */
  const nextCheck = async (venue?: string) => {
    if (!check) return;
    if (check.at + 1 < check.steps.length) { setCheck({ ...check, at: check.at + 1 }); return; }
    const hadNotes = Object.keys(check.notes).length > 0;
    if (venue !== undefined) setVenueName(venue);
    if (hadNotes || venue?.trim()) {
      try { hydrateFrom(await amend.mutateAsync(buildAmendPayload(venue ?? venueName))); } catch { return; }
    }
    setCheck(null);
    setEditing(null);
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!isDirty) return true;
    try { hydrateFrom(await amend.mutateAsync(buildAmendPayload())); return true; } catch { return false; }
  };

  const onShare = async () => {
    if (!billId) return;
    if (!payout.isPending && !payout.data) {
      router.push(`/payout-account?returnTo=${encodeURIComponent(`/confirm-bill/${billId}`)}`);
      return;
    }
    if (!(await saveDraft())) return;
    let status = fee.data?.status;
    if (feeDue !== null) {
      // Saving may have moved the bill across £100, so take the fee from the server.
      const fresh = await fee.refetch();
      status = fresh.data?.status;
      if (status === 'unpaid') {
        router.push(`/table-fee/${billId}`);
        return;
      }
    }
    try {
      const created = await createSession.mutateAsync({ billId });
      await shareSession(created.sessionId);
      router.replace(`/session/${created.sessionId}/share?new=${status === 'free' ? 'free' : status === 'credit' ? 'credit' : '1'}`);
    } catch (err) {
      // The server asks for the fee (the credit went on another bill meanwhile).
      if (isFeeRequired(err)) { router.push(`/table-fee/${billId}`); return; }
      const existing = existingSessionIdFromError(err);
      if (existing) router.replace(`/session/${existing}`);
    }
  };

  const onSaveMidSession = async () => {
    if (!sessionId) return;
    try {
      await amend.mutateAsync(buildAmendPayload());
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      router.replace(`/session/${sessionId}`);
    } catch { /* shown inline */ }
  };

  if (bill.isPending || (bill.isSuccess && !hydrated)) return <BillLoading />;
  if (bill.isError) {
    return <Centre><Notice tone="error" title="Couldn’t load the bill.">{bill.error.message}</Notice><Button tone="secondary" href="/" replace>Back to bills</Button></Centre>;
  }
  if (check) {
    const step = check.steps[check.at]!;
    const of = check.steps.length > 1 ? ` · ${check.at + 1} of ${check.steps.length}` : '';
    const it = items.find((d) => d.itemId === step);
    return (
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        {step === 'venue' ? (
          <>
            <Title title="Where was this?" sub={`Not on the receipt${of}`} />
            <VenueAsk
              busy={amend.isPending}
              onSkip={() => { if (billId) skipVenue(billId); void nextCheck(); }}
              onDone={(name) => void nextCheck(name)}
            />
          </>
        ) : (
          <>
            <Title title="Check this" sub={`${check.notes[step] ?? 'Hard to read'}${of}`} />
            {photo.data ? (
              <a href={photo.data.url} target="_blank" rel="noopener noreferrer" aria-label="Open the photo full size">
                <img src={photo.data.url} alt="Photo of the bill" className="photo-check" />
              </a>
            ) : null}
            {it ? (
              <ItemEditor
                key={it.draftId}
                item={it}
                claimed={0}
                doneLabel="Looks right"
                onChange={(patch) => updateItem(it.draftId, patch)}
                onDone={() => void nextCheck()}
                onRemove={() => { removeItem(it.draftId); void nextCheck(); }}
              />
            ) : null}
          </>
        )}
        {amend.isError ? <Notice tone="error" title="Couldn’t save.">{amend.error.message}</Notice> : null}
      </Page>
    );
  }

  const b = bill.data as Bill & { parsedTotalPence?: number };
  const busy = amend.isPending || createSession.isPending;
  const existingSessionId = existingSessionIdFromError(createSession.error);
  const printed = b.parsedTotalPence;
  const mismatch = printed !== undefined && printed !== totalPence;
  // Nothing on the photo names the place (#65): the check step asked; here
  // it's a field at the top until a name is saved.
  const noVenue = !b.venue?.name;
  // The lines don't make the printed total: the strongest sign a price was
  // misread, since the reader's own notes miss some (#107). Live as lines are fixed.
  const offBy = mismatch && items.length > 0 ? totalPence - printed : 0;
  // No printed total to check against (a cut-off photo, usually). Only
  // before sharing: once guests are claiming, retaking the photo would
  // throw their claims away.
  const noTotal = !isMidSession && items.length > 0 && printed === undefined;
  const servicePct = subtotalPence > 0 && servicePence > 0 ? ` ${Math.round((servicePence / subtotalPence) * 1000) / 10}%` : '';

  return (
    <>
      <Page sub>
        {isMidSession ? <BackLink href={`/session/${sessionId}`}>Bill</BackLink> : <BackLink href="/">Bills</BackLink>}
        <Title title={isMidSession ? 'Fix the bill' : 'Check it matches'} sub={isMidSession ? undefined : items.length === 0 ? 'Nothing read. Add the items yourself, or scan again.' : 'Same lines and total as the paper one? Tap a line to fix it.'} />

        {resumed ? <Notice title="Picked up where you left off" /> : null}

        {editing === 'venue' ? (
          <VenueEditor value={venueName} onChange={setVenueName} onDone={() => setEditing(null)} />
        ) : noVenue ? (
          <VenueField disabled={busy} onSave={setVenueName} />
        ) : null}

        {noTotal ? (
          <Notice tone="warn" title="No total on the photo">
            Bottom cut off? We can&rsquo;t check the sum.{' '}
            <button type="button" className="link-btn" onClick={() => router.push('/capture')}>
              Retake photo
            </button>
          </Notice>
        ) : null}

        {offBy !== 0 ? (
          <Notice tone="warn" title="Doesn’t add up">
            {formatGBP(Math.abs(offBy))} {offBy < 0 ? 'under' : 'over'} the receipt’s {formatGBP(printed!)}. Check the prices.{' '}
            <button type="button" className="link-btn" onClick={() => setShowPhoto((v) => !v)} aria-expanded={showPhoto}>
              {showPhoto ? 'Hide photo' : 'See photo'}
            </button>
          </Notice>
        ) : null}
        {offBy !== 0 && showPhoto ? (
          photo.data ? (
            <a href={photo.data.url} target="_blank" rel="noopener noreferrer" aria-label="Open the photo full size">
              <img src={photo.data.url} alt="Photo of the bill" className="photo-check" />
            </a>
          ) : photo.isError ? <p className="field__hint">Photo not available.</p> : null
        ) : null}

        {/* L3: the bill as a receipt. A pencil on every line opens it in place (L3.1). */}
        <Receipt
          label="The bill"
          head={noVenue || editing === 'venue'
            ? 'Your bill'
            : <button type="button" className="link-btn receipt__venue" onClick={() => setEditing('venue')} disabled={editing !== null} aria-label={`Change venue: ${b.venue!.name}`}>{b.venue!.name}</button>}
          end={formatDay(b.createdAt)}
        >
          {items.map((it) =>
            it.draftId === editing ? (
              <ItemEditor
                key={it.draftId}
                item={it}
                claimed={it.itemId ? claimsByItemId.get(it.itemId) ?? 0 : 0}
                onChange={(patch) => updateItem(it.draftId, patch)}
                onDone={finishEditing}
                onCancel={cancelEditing}
                onRemove={() => { removeItem(it.draftId); finishEditing(); }}
              />
            ) : (
              <EditLine
                key={it.draftId}
                name={it.quantity > 1 ? `${it.quantity} × ${it.name || 'Item'}` : it.name || 'Item'}
                label={it.name || 'Item'}
                price={pounds(parsePence(it.unitPricePounds) * it.quantity)}
                disabled={busy || editing !== null}
                onEdit={() => startEditing(it)}
              />
            ),
          )}
          {editing === 'service'
            ? <MoneyEditor label="Service" value={servicePounds} onChange={setServicePounds} onDone={() => setEditing(null)} />
            : <EditLine quiet name={`Service${servicePct}`} label="service" price={pounds(servicePence)} disabled={busy || editing !== null} onEdit={() => setEditing('service')} />}
          {editing === 'tax'
            ? <MoneyEditor label="Tax" value={taxPounds} onChange={setTaxPounds} onDone={() => setEditing(null)} />
            : taxPence > 0 ? <EditLine quiet name="Tax" label="tax" price={pounds(taxPence)} disabled={busy || editing !== null} onEdit={() => setEditing('tax')} /> : null}
          <ReceiptLine strong name="Total" price={<span className="receipt__total" data-testid="bill-total">{formatGBP(totalPence)}</span>} />
        </Receipt>
        <div className="bill-tools">
          <button type="button" className="link-btn" onClick={addAndEdit} disabled={busy || editing !== null}><PlusIcon />Add item</button>
          {taxPence > 0 || editing === 'tax' ? null : <button type="button" className="link-btn" onClick={() => setEditing('tax')} disabled={busy || editing !== null}>Add tax</button>}
        </div>
        {!mismatch && printed !== undefined && items.length > 0 ? <p className="adds-up"><TickIcon size={16} />Adds up to the receipt</p> : null}

        {createSession.isError && !existingSessionId ? <Notice tone="error" title="Couldn’t start the bill.">{createSession.error.message}</Notice> : null}
        {amend.isError ? <Notice tone="error" title="Couldn’t save.">{amend.error.message}</Notice> : null}
        {existingSessionId ? <Button tone="secondary" href={`/session/${existingSessionId}`} replace>Open the existing bill</Button> : null}
        {asking && !isMidSession ? (
          <div ref={askRef} tabIndex={-1} className="confirm-inline" role="group" aria-labelledby="qr-t">
            <h2 id="qr-t" className="confirm-inline__h">{feeDue !== null ? `Hold ${formatGBP(feeDue)} to share this bill?` : freeCredit ? 'Use your free credit?' : 'Spend 1 credit?'}</h2>
            {feeDue !== null ? (
              <p className="muted">Nothing is taken now. Your guests round their share up to the next pound to cover it: at most {formatGBP(feeDue)}, taken when you settle. Nobody joins? It’s released.</p>
            ) : freeCredit ? (
              <>
                <p className="muted">One free bill a month. Next one {nextMonth()}.</p>
                <p className="muted">Free for everyone at the table. Given back if nobody joins.</p>
              </>
            ) : (
              <p className="muted">You have {creditsLeft} {creditsLeft === 1 ? 'credit' : 'credits'}. This bill uses 1.</p>
            )}
            <div className="confirm-inline__acts">
              <Button tone="secondary" onClick={() => setAsking(false)}>Not yet</Button>
              <Button busy={busy || fee.isFetching} onClick={() => void onShare()}>{feeDue !== null ? `Hold ${formatGBP(feeDue)} & get QR code` : freeCredit ? 'Use free credit' : 'Spend 1 credit'}</Button>
            </div>
          </div>
        ) : null}
      </Page>
      {asking && !isMidSession ? null : (
        <ActionBar>
          {isMidSession ? (
            <Button grow busy={busy} disabled={editing !== null || !isDirty} onClick={onSaveMidSession}>{isDirty ? 'Save' : 'No changes'}</Button>
          ) : (
            <Button grow busy={busy || fee.isFetching} disabled={editing !== null || items.length === 0} onClick={onGenerate}>Generate QR code</Button>
          )}
        </ActionBar>
      )}
    </>
  );
}

/** A receipt line with its pencil (#223): the row and the pencil both open it. */
function EditLine({ name, label, price, quiet, disabled, onEdit }: { name: string; label: string; price: string; quiet?: boolean; disabled: boolean; onEdit: () => void }) {
  return (
    <div className={`receipt__line receipt__line--edit${quiet ? ' receipt__line--quiet' : ''}`} onClick={disabled ? undefined : onEdit}>
      <span className="receipt__item">{name}</span>
      <span className="receipt__price">{price}</span>
      <button type="button" className="receipt__pen" aria-label={`Edit ${label}`} disabled={disabled} onClick={(e) => { e.stopPropagation(); onEdit(); }}><PencilIcon /></button>
    </div>
  );
}

const formatDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }).replace(',', '').toUpperCase();
/** "1 Dec": when the next free bill comes (the first of next month, UK time). */
function nextMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function ItemEditor({ item, claimed, onChange, onDone, onCancel, onRemove, doneLabel = 'Done' }: {
  item: DraftItem; claimed: number; onChange: (p: Partial<DraftItem>) => void; onDone: () => void;
  /** Absent in the check step: there's nothing to go back to. */
  onCancel?: () => void;
  onRemove: () => void; doneLabel?: string;
}) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onDone(); }
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
  };
  const minQty = Math.max(1, claimed);
  return (
    <div className="editor" onKeyDown={onKey}>
      <div className="field">
        <label htmlFor={`name-${item.draftId}`}>Item</label>
        <input id={`name-${item.draftId}`} className="input" value={item.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="What was it?" autoCorrect="off" autoFocus />
      </div>
      <div className="editor__row">
        <div className="field" style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor={`price-${item.draftId}`}>Price each</label>
          <div className="money">
            <span>£</span>
            <input id={`price-${item.draftId}`} className="input" value={item.unitPricePounds} onChange={(e) => onChange({ unitPricePounds: e.target.value })} onBlur={() => onChange({ unitPricePounds: pounds(parsePence(item.unitPricePounds)) })} onFocus={(e) => e.target.select()} inputMode="decimal" placeholder="0.00" />
          </div>
        </div>
        <div className="field" style={{ flex: 'none' }}>
          <span className="field__label">Quantity</span>
          <div className="stepper" style={{ height: 52 }}>
            <button type="button" aria-label={`One fewer${item.name.trim() ? ` ${item.name.trim()}` : ''}`} disabled={item.quantity <= minQty} onClick={() => onChange({ quantity: Math.max(minQty, item.quantity - 1) })}>−</button>
            <span aria-live="polite">{item.quantity}</span>
            <button type="button" aria-label={`One more${item.name.trim() ? ` ${item.name.trim()}` : ''}`} onClick={() => onChange({ quantity: item.quantity + 1 })}>+</button>
          </div>
        </div>
      </div>
      {claimed > 0 ? <p className="field__hint">{claimed} already claimed, so it can’t go below {claimed}.</p> : null}
      <div className="btn-row btn-row--end">
        <Button tone="text" small onClick={onRemove} disabled={claimed > 0} className={claimed > 0 ? undefined : 'btn--text-danger'}>Remove</Button>
        <span style={{ flex: 1 }} />
        {onCancel ? <Button tone="secondary" small onClick={onCancel}>Cancel</Button> : null}
        <Button small onClick={onDone}>{doneLabel}</Button>
      </div>
    </div>
  );
}

function VenueEditor({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: () => void }) {
  return (
    <div className="editor" style={{ borderRadius: 'var(--radius)' }}>
      <div className="editor__row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="venue-name">Venue</label>
          <input
            id="venue-name"
            className="input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Where was this?"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onDone(); } }}
          />
        </div>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/**
 * Review bill's "Where was this?" (#65) when no place is saved: typed
 * here, saved (through the autosave) when the field is left or Enter pressed.
 */
function VenueField({ disabled, onSave }: { disabled: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState('');
  const save = () => { if (name.trim()) onSave(name.trim()); };
  return (
    <div className="field">
      <label htmlFor="venue-field">Where was this?</label>
      <input
        id="venue-field"
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        placeholder="Restaurant"
        aria-describedby="venue-field-hint"
        disabled={disabled}
        enterKeyHint="done"
      />
      <span id="venue-field-hint" className="field__hint">Not on the photo. Shown to everyone.</span>
    </div>
  );
}

function MoneyEditor({ label, value, onChange, onDone }: { label: string; value: string; onChange: (v: string) => void; onDone: () => void }) {
  return (
    <div className="editor" style={{ borderRadius: 'var(--radius)' }}>
      <div className="editor__row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`money-${label}`}>{label}</label>
          <div className="money">
            <span>£</span>
            <input id={`money-${label}`} className="input" value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => onChange(pounds(parsePence(value)))} onFocus={(e) => e.target.select()} inputMode="decimal" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onDone(); } }} />
          </div>
        </div>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** The check step's last question when the receipt names no place. */
function VenueAsk({ busy, onSkip, onDone }: { busy: boolean; onSkip: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="editor" style={{ borderRadius: 'var(--radius)' }}>
      <div className="field">
        <label htmlFor="venue-ask">Restaurant</label>
        <input
          id="venue-ask"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Where was this?"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { e.preventDefault(); onDone(name.trim()); } }}
        />
      </div>
      <div className="btn-row btn-row--end">
        <span style={{ flex: 1 }} />
        <Button tone="secondary" small onClick={onSkip} disabled={busy}>Skip</Button>
        <Button small busy={busy} onClick={() => onDone(name.trim())} disabled={!name.trim()}>Done</Button>
      </div>
    </div>
  );
}
