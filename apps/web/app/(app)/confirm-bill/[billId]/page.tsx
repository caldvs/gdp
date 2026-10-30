'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useCreateSession, useSession } from '@gdp/core/api/hooks/useSession';
import { useAmendBill } from '@gdp/core/api/hooks/useAmendBill';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { formatGBP } from '@gdp/core/lib/money';
import { Pencil } from 'lucide-react';
import { useScreenTitle } from '@/lib/screen';
import { BillImageModal } from '@/components/BillImageModal';
import {
  BillTotals, BodyText, Button, CenterSpinner, DisplayText, LinkButton, Mini, Notice,
  Receipt, ReceiptItem, Rule, Spinner, TextField, TotalsRow,
} from '@/components/ui';

type Bill = components['schemas']['Bill'];
type BillItem = components['schemas']['BillItem'];
type Category = BillItem['category'];
type DraftItem = { draftId: string; itemId?: string; name: string; unitPricePounds: string; quantity: number; category: Category };

function existingSessionIdFromError(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== 'SESSION_INVALID_STATE') return undefined;
  const d = err.details as { sessionId?: unknown } | undefined;
  return typeof d?.sessionId === 'string' ? d.sessionId : undefined;
}

function amendErrorMessage(err: Error, items: BillItem[]): string {
  if (err instanceof ApiError && err.code === 'CLAIMS_EXCEED_QUANTITY') {
    const d = err.details as { itemId?: string; claimed?: number; newQuantity?: number } | undefined;
    const name = items.find((it) => it.itemId === d?.itemId)?.name ?? 'an item';
    return `You set "${name}" to ${d?.newQuantity ?? '?'}, but ${d?.claimed ?? '?'} are already claimed. Raise the quantity, or ask diners to drop their claims first.`;
  }
  return err.message;
}

const fromBillItem = (it: BillItem, idx: number): DraftItem => ({
  draftId: `existing-${it.itemId}-${idx}`,
  itemId: it.itemId,
  name: it.name,
  unitPricePounds: (it.unitPricePence / 100).toFixed(2),
  quantity: it.quantity,
  category: it.category,
});

const blankItem = (): DraftItem => ({
  draftId: `new-${Math.random().toString(36).slice(2, 9)}`,
  name: '',
  unitPricePounds: '0.00',
  quantity: 1,
  category: 'food',
});

const parsePence = (s: string): number => {
  const n = Number(s);
  return !Number.isFinite(n) || n < 0 ? 0 : Math.round(n * 100);
};

export default function ConfirmBillPage() {
  return (
    <Suspense fallback={<CenterSpinner />}>
      <ConfirmBill />
    </Suspense>
  );
}

function ConfirmBill() {
  const { billId } = useParams<{ billId: string }>();
  const sessionId = useSearchParams().get('sessionId') ?? undefined;
  const isMidSession = !!sessionId;
  const router = useRouter();
  const queryClient = useQueryClient();
  const bill = useBill(billId);
  const session = useSession(sessionId);
  const amend = useAmendBill(billId ?? '');
  const createSession = useCreateSession();
  const payout = usePayoutAccount();

  const [items, setItems] = useState<DraftItem[]>([]);
  const [servicePounds, setServicePounds] = useState('0.00');
  const [taxPounds, setTaxPounds] = useState('0.00');
  const [hydrated, setHydrated] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [mode, setMode] = useState<'review' | 'edit'>(isMidSession ? 'edit' : 'review');
  // Review screen: the item being edited in place, and its values before
  // editing (so Escape / Cancel can put them back).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSnapshot, setEditingSnapshot] = useState<DraftItem | null>(null);

  useEffect(() => {
    if (bill.data && !hydrated) {
      setItems(bill.data.items.map(fromBillItem));
      setServicePounds((bill.data.serviceChargePence / 100).toFixed(2));
      setTaxPounds((bill.data.taxPence / 100).toFixed(2));
      setHydrated(true);
    }
  }, [bill.data, hydrated]);

  const venueName = bill.data?.venue?.name;
  useScreenTitle(mode === 'review' && items.length > 0 ? 'Review bill' : venueName ?? 'Bill');

  const subtotalPence = useMemo(() => items.reduce((acc, it) => acc + parsePence(it.unitPricePounds) * it.quantity, 0), [items]);
  const servicePence = parsePence(servicePounds);
  const taxPence = parsePence(taxPounds);
  const totalPence = subtotalPence + servicePence + taxPence;

  const isDirty = useMemo(() => {
    const b = bill.data;
    if (!b) return false;
    if (b.items.length !== items.length || b.serviceChargePence !== servicePence || b.taxPence !== taxPence) return true;
    return items.some((local, i) => {
      const server = b.items[i];
      return !server || local.itemId !== server.itemId || local.name !== server.name ||
        parsePence(local.unitPricePounds) !== server.unitPricePence || local.quantity !== server.quantity || local.category !== server.category;
    });
  }, [bill.data, items, servicePence, taxPence]);

  const existingSessionId = existingSessionIdFromError(createSession.error);

  // Review screen: persist as soon as an inline edit is finished (or an
  // item removed), so nothing is lost if the lead leaves the page.
  useEffect(() => {
    if (mode !== 'review' || editingId !== null || !hydrated || !isDirty || amend.isPending) return;
    void saveDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editingId, isDirty, hydrated]);

  const claimsByItemId = useMemo(() => {
    const m = new Map<string, { count: number; names: string[] }>();
    for (const p of session.data?.participants ?? []) {
      const seen = new Set<string>();
      for (const id of p.claimedItemIds) {
        const entry = m.get(id) ?? { count: 0, names: [] };
        entry.count += 1;
        if (!seen.has(id)) { entry.names.push(p.displayName); seen.add(id); }
        m.set(id, entry);
      }
    }
    return m;
  }, [session.data]);

  const updateItem = (draftId: string, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it) => (it.draftId === draftId ? { ...it, ...patch } : it)));
  const removeItem = (draftId: string) => setItems((prev) => prev.filter((it) => it.draftId !== draftId));

  const startEditing = (it: DraftItem) => {
    setEditingId(it.draftId);
    setEditingSnapshot(it);
  };
  const cancelEditing = () => {
    if (editingSnapshot) {
      // A brand-new item that was never filled in just disappears.
      if (!editingSnapshot.itemId && !editingSnapshot.name.trim()) removeItem(editingSnapshot.draftId);
      else updateItem(editingSnapshot.draftId, editingSnapshot);
    }
    setEditingId(null);
    setEditingSnapshot(null);
  };
  const finishEditing = () => {
    setEditingId(null);
    setEditingSnapshot(null);
  };
  const addAndEdit = () => {
    const it = blankItem();
    setItems((prev) => [...prev, it]);
    startEditing(it);
  };

  const buildAmendPayload = () => ({
    items: items.map((it) => ({
      ...(it.itemId ? { itemId: it.itemId } : {}),
      name: it.name.trim() || 'Item',
      unitPricePence: parsePence(it.unitPricePounds),
      quantity: Math.max(1, Math.floor(it.quantity)),
      category: it.category,
    })),
    taxPence,
    serviceChargePence: servicePence,
  });

  // Load a bill (fresh from the server, or the last saved one) into the
  // editable draft. Items then carry their server itemIds, so later saves
  // update them instead of re-adding them.
  const hydrateFrom = (bill: Bill) => {
    setItems(bill.items.map(fromBillItem));
    setServicePounds((bill.serviceChargePence / 100).toFixed(2));
    setTaxPounds((bill.taxPence / 100).toFixed(2));
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!isDirty) return true;
    try {
      hydrateFrom(await amend.mutateAsync(buildAmendPayload()));
      return true;
    } catch {
      return false;
    }
  };

  const onCreateSession = async () => {
    if (!billId) return;
    // Diners need somewhere to pay — get the lead's bank details first.
    if (!payout.isPending && !payout.data) {
      router.push(`/payout-account?returnTo=${encodeURIComponent(`/confirm-bill/${billId}`)}`);
      return;
    }
    if (!(await saveDraft())) return;
    try {
      const created = await createSession.mutateAsync({ billId });
      await api(`/v1/sessions/${created.sessionId}/share`, { method: 'POST' });
      router.replace(`/session/${created.sessionId}?showQr=1`);
    } catch (err) {
      const existing = existingSessionIdFromError(err);
      if (existing) router.replace(`/session/${existing}`);
    }
  };

  const onSaveAmend = async () => {
    if (!billId || !sessionId) return;
    try {
      await amend.mutateAsync(buildAmendPayload());
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      router.replace(`/session/${sessionId}`);
    } catch {
      // error shown inline
    }
  };

  if (bill.isPending || (bill.isSuccess && !hydrated)) return <CenterSpinner />;
  if (bill.isError) {
    return (
      <div className="center">
        <Notice title="Couldn't load the bill." detail={bill.error.message} />
        <Button variant="ghost" href="/capture" replace>Start over</Button>
      </div>
    );
  }

  const b = bill.data as Bill & { parsedTotalPence?: number };
  const busy = amend.isPending || createSession.isPending;
  const imageModal = <BillImageModal billId={billId} visible={imageOpen} onClose={() => setImageOpen(false)} />;

  if (mode === 'review' && items.length === 0) {
    return (
      <div className="screen stack">
        <Mini>hmm</Mini>
        <DisplayText size="md" className="mt-xs">Drew a blank on this one.</DisplayText>
        <BodyText className="mt-sm">Type the items in yourself, or grab another photo and we&apos;ll have another go.</BodyText>
        <div className="stack gap-sm mt-lg">
          <Notice title="Couldn't read any items." detail="Empty receipts usually mean a glare on the print or the bill was off-frame." />
          <Button variant="ghost" onClick={() => setMode('edit')}>+ Add items manually</Button>
          <Button href="/capture" replace>Retake the photo →</Button>
        </div>
        {imageModal}
      </div>
    );
  }

  if (mode === 'review') {
    const venueLine = [
      b.venue?.address?.split(',')[0]?.trim(),
      b.parsedFrom?.parsedAt ? new Date(b.parsedFrom.parsedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null,
    ].filter(Boolean).join(' · ');
    return (
      <>
        <div className="screen screen--sticky stack">
          {b.venue?.name ? <DisplayText size="md" as="h2" className="mt-xs">{b.venue.name}</DisplayText> : null}
          {venueLine ? <BodyText className="t-mute mt-xs">{venueLine}</BodyText> : null}
          <BodyText className="mt-sm">Bill look right? Fix anything the scan got wrong, then split it.</BodyText>
          <Receipt className="mt-base">
            {items.map((it) =>
              it.draftId === editingId ? (
                <InlineItemEditor
                  key={it.draftId}
                  item={it}
                  busy={amend.isPending}
                  onChange={(patch) => updateItem(it.draftId, patch)}
                  onDone={finishEditing}
                  onCancel={cancelEditing}
                  onRemove={() => { removeItem(it.draftId); setEditingId(null); setEditingSnapshot(null); }}
                />
              ) : (
                <button
                  key={it.draftId}
                  type="button"
                  className="ritem ritem--editable"
                  onClick={() => startEditing(it)}
                  disabled={busy}
                  aria-label={`Edit ${it.name || 'item'}`}
                >
                  <span className="ritem__name">{it.quantity > 1 ? `${it.quantity}× ${it.name || 'Item'}` : it.name || 'Item'}</span>
                  <span className="ritem__right">
                    <span className="ritem__price">{formatGBP(parsePence(it.unitPricePounds) * it.quantity)}</span>
                    <Pencil size={13} className="ritem__pencil" aria-hidden />
                  </span>
                </button>
              ),
            )}
            <button type="button" className="ritem ritem--add" onClick={addAndEdit} disabled={busy}>+ add an item</button>
            <BillTotals subtotalPence={subtotalPence} servicePence={servicePence} taxPence={taxPence} totalPence={totalPence} />
          </Receipt>
          <Mini className="t-center mt-sm">tap an item to fix its name or price</Mini>
          <ParsedTotalMismatch bill={b} computedTotalPence={totalPence} />
          <LinkButton align="center" className="mt-md" onClick={() => setImageOpen(true)}>view original photo</LinkButton>
          {createSession.isError && !existingSessionId ? (
            <Notice className="mt-md" title="Couldn't start the session." detail={createSession.error.message} />
          ) : null}
          {amend.isError ? <Notice className="mt-md" title="Couldn't save." detail={amendErrorMessage(amend.error, b.items)} /> : null}
          {existingSessionId ? (
            <Button variant="ghost" className="mt-md" href={`/session/${existingSessionId}`} replace>Continue your existing session</Button>
          ) : null}
        </div>
        <div className="sticky-bar">
          <div className="sticky-bar__inner">
            <div className="sticky-bar__row">
              <Button variant="ghost" onClick={() => { setEditingId(null); setMode('edit'); }} disabled={busy}>Edit all</Button>
              <Button disabled={busy || editingId !== null} onClick={onCreateSession}>{busy ? <Spinner /> : 'Open the session →'}</Button>
            </div>
          </div>
        </div>
        {imageModal}
      </>
    );
  }

  return (
    <>
      <div className="screen screen--sticky stack">
        <Mini>edit bill</Mini>
        <DisplayText size="md" as="h2" className="mt-xs">Fix anything the parser got wrong.</DisplayText>
        <BodyText className="mt-sm">
          {isMidSession
            ? 'Diners will be asked to re-confirm their picks after you save.'
            : 'Names, prices, quantities, service — adjust whatever needs it.'}
        </BodyText>
        <LinkButton className="mt-sm" onClick={() => setImageOpen(true)}>view photo</LinkButton>

        <div className="edit-items mt-base">
          {items.map((it) => {
            const claim = it.itemId ? claimsByItemId.get(it.itemId) : undefined;
            return (
              <div key={it.draftId} className="edit-item">
                <div className="edit-item__row">
                  <TextField
                    variant="compact"
                    aria-label="Item name"
                    value={it.name}
                    onChange={(e) => updateItem(it.draftId, { name: e.target.value })}
                    placeholder="Item name"
                    autoCorrect="off"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="remove-btn"
                    aria-label={`Remove ${it.name || 'item'}`}
                    onClick={() => removeItem(it.draftId)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
                {isMidSession && claim && claim.count > 0 ? (
                  <div className="claim-badge">{claim.count} claim{claim.count === 1 ? '' : 's'} · {claim.names.join(', ').toLowerCase()}</div>
                ) : null}
                <div className="edit-item__row">
                  <div className="price-field">
                    <TextField
                      variant="compact"
                      aria-label={`Price of ${it.name || 'item'}`}
                      value={it.unitPricePounds}
                      onChange={(e) => updateItem(it.draftId, { unitPricePounds: e.target.value })}
                      onBlur={() => updateItem(it.draftId, { unitPricePounds: (parsePence(it.unitPricePounds) / 100).toFixed(2) })}
                      placeholder="0.00"
                      inputMode="decimal"
                      disabled={busy}
                      prefix="£"
                    />
                    <span className="hint-inline">each</span>
                  </div>
                  <div className="qty">
                    <button type="button" aria-label="Decrease quantity" disabled={busy || it.quantity <= 1}
                      onClick={() => updateItem(it.draftId, { quantity: Math.max(1, it.quantity - 1) })}>−</button>
                    <span className="qty__v">{it.quantity}×</span>
                    <button type="button" aria-label="Increase quantity" disabled={busy}
                      onClick={() => updateItem(it.draftId, { quantity: it.quantity + 1 })}>+</button>
                  </div>
                  <span className="line-total">{formatGBP(parsePence(it.unitPricePounds) * it.quantity)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <button type="button" className="add-item mt-md" onClick={() => setItems((prev) => [...prev, blankItem()])} disabled={busy}>
          + add item
        </button>

        <div className="edit-totals">
          <TotalsRow label="subtotal" value={formatGBP(subtotalPence)} />
          <div className="edit-total">
            <Mini>service charge</Mini>
            <TextField variant="compact" aria-label="Service charge" value={servicePounds} onChange={(e) => setServicePounds(e.target.value)}
              inputMode="decimal" disabled={busy} prefix="£" />
          </div>
          <div className="edit-total">
            <Mini>tax</Mini>
            <TextField variant="compact" aria-label="Tax" value={taxPounds} onChange={(e) => setTaxPounds(e.target.value)}
              inputMode="decimal" disabled={busy} prefix="£" />
          </div>
          <Rule style={{ margin: '6px 0' }} />
          <TotalsRow label="TOTAL" value={formatGBP(totalPence)} emphasis="strong" />
        </div>
        <ParsedTotalMismatch bill={b} computedTotalPence={totalPence} />
        {amend.isError ? <Notice className="mt-md" title="Couldn't save." detail={amendErrorMessage(amend.error, b.items)} /> : null}
      </div>

      <div className="sticky-bar">
        <div className="sticky-bar__inner">
          <div className="sticky-bar__row">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (isMidSession) {
                  router.replace(`/session/${sessionId}`);
                } else {
                  hydrateFrom(b);
                  amend.reset();
                  setMode('review');
                }
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || items.length === 0 || (isMidSession && !isDirty)}
              onClick={() => {
                if (isMidSession) void onSaveAmend();
                else void saveDraft().then((ok) => ok && setMode('review'));
              }}
            >
              {busy ? <Spinner /> : isMidSession && !isDirty ? 'No changes' : 'Save changes →'}
            </Button>
          </div>
        </div>
      </div>
      {imageModal}
    </>
  );
}

function InlineItemEditor({ item, busy, onChange, onDone, onCancel, onRemove }: {
  item: DraftItem; busy: boolean; onChange: (patch: Partial<DraftItem>) => void;
  onDone: () => void; onCancel: () => void; onRemove: () => void;
}) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onDone(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  return (
    <div className="ritem-edit" onKeyDown={onKey}>
      <TextField
        variant="compact"
        aria-label="Item name"
        value={item.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Item name"
        autoCorrect="off"
        autoFocus
      />
      <div className="edit-item__row">
        <div className="price-field">
          <TextField
            variant="compact"
            aria-label={`Price of ${item.name || 'item'}`}
            value={item.unitPricePounds}
            onChange={(e) => onChange({ unitPricePounds: e.target.value })}
            onBlur={() => onChange({ unitPricePounds: (parsePence(item.unitPricePounds) / 100).toFixed(2) })}
            onFocus={(e) => e.target.select()}
            placeholder="0.00"
            inputMode="decimal"
            prefix="£"
          />
          {item.quantity > 1 ? <span className="hint-inline">each</span> : null}
        </div>
        <div className="qty">
          <button type="button" aria-label="Decrease quantity" disabled={item.quantity <= 1}
            onClick={() => onChange({ quantity: Math.max(1, item.quantity - 1) })}>−</button>
          <span className="qty__v">{item.quantity}×</span>
          <button type="button" aria-label="Increase quantity" onClick={() => onChange({ quantity: item.quantity + 1 })}>+</button>
        </div>
      </div>
      <div className="ritem-edit__actions">
        <button type="button" className="link-btn link-btn--danger" onClick={onRemove} disabled={busy}>remove</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="link-btn link-btn--mute" onClick={onCancel}>cancel</button>
        <Button variant="quiet" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function ParsedTotalMismatch({ bill, computedTotalPence }: { bill: Bill & { parsedTotalPence?: number }; computedTotalPence: number }) {
  const parsed = bill.parsedTotalPence;
  if (parsed === undefined || parsed === computedTotalPence) return null;
  const delta = computedTotalPence - parsed;
  return (
    <Notice
      className="mt-md"
      title="Worth a double-check."
      detail={`The receipt's printed total is ${formatGBP(parsed)} but the items + extras add up to ${formatGBP(computedTotalPence)} (${delta > 0 ? '+' : '−'}${formatGBP(Math.abs(delta))}). Might be a parser miss or a discount on the bill — review the items and adjust if needed.`}
    />
  );
}
