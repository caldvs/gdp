'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useCreateSession, useSession } from '@gdp/core/api/hooks/useSession';
import { useAmendBill } from '@gdp/core/api/hooks/useAmendBill';
import { useTableFeeStatus } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { formatGBP } from '@gdp/core/lib/money';
import {
  ActionBar, BackLink, BillSkeleton, Box, Button, Centre, Notice, Page, PlusIcon, RowButton, Title, TotalLine, Totals,
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

function existingSessionIdFromError(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== 'SESSION_INVALID_STATE') return undefined;
  const d = err.details as { sessionId?: unknown } | undefined;
  return typeof d?.sessionId === 'string' ? d.sessionId : undefined;
}

function BillLoading() {
  return (
    <Page sub>
      <Title title="Review bill" />
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
  const sessionId = useSearchParams().get('sessionId') ?? undefined;
  const isMidSession = !!sessionId;
  const router = useRouter();
  const queryClient = useQueryClient();
  const bill = useBill(billId);
  const session = useSession(sessionId);
  const amend = useAmendBill(billId ?? '');
  const createSession = useCreateSession();
  const payout = usePayoutAccount();
  // The table fee is paid on the last step before the QR code. Null = no
  // fee here (Stripe not set up on the API or the web app).
  const fee = useTableFeeStatus(billId, { enabled: !!STRIPE_PUBLISHABLE_KEY && !isMidSession });

  const [items, setItems] = useState<DraftItem[]>([]);
  const [servicePounds, setServicePounds] = useState('0.00');
  const [taxPounds, setTaxPounds] = useState('0.00');
  const [hydrated, setHydrated] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // draftId | 'service' | 'tax'
  const [snapshot, setSnapshot] = useState<DraftItem | null>(null);

  useEffect(() => {
    if (bill.data && !hydrated) {
      hydrateFrom(bill.data);
      setHydrated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill.data, hydrated]);

  const hydrateFrom = (b: Bill) => {
    setItems(b.items.map(fromBillItem));
    setServicePounds(pounds(b.serviceChargePence));
    setTaxPounds(pounds(b.taxPence));
  };

  const subtotalPence = useMemo(() => items.reduce((acc, it) => acc + parsePence(it.unitPricePounds) * it.quantity, 0), [items]);
  const servicePence = parsePence(servicePounds);
  const taxPence = parsePence(taxPounds);
  const totalPence = subtotalPence + servicePence + taxPence;
  // Follow the total on screen (£2, or £3 over £100) so the button is right
  // while editing; the server sets the actual charge.
  const feeDue = fee.data?.status === 'unpaid' ? (totalPence > 10_000 ? 300 : 200) : null;

  const isDirty = useMemo(() => {
    const b = bill.data;
    if (!b) return false;
    if (b.items.length !== items.length || b.serviceChargePence !== servicePence || b.taxPence !== taxPence) return true;
    return items.some((local, i) => {
      const server = b.items[i];
      return !server || local.itemId !== server.itemId || local.name !== server.name ||
        parsePence(local.unitPricePounds) !== server.unitPricePence || local.quantity !== server.quantity;
    });
  }, [bill.data, items, servicePence, taxPence]);

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

  const buildAmendPayload = () => ({
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
  });

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
    if (feeDue !== null) {
      // Saving may have moved the bill across £100, so take the fee from the server.
      const fresh = await fee.refetch();
      if (fresh.data?.status === 'unpaid') {
        router.push(`/table-fee/${billId}`);
        return;
      }
    }
    try {
      const created = await createSession.mutateAsync({ billId });
      await api(`/v1/sessions/${created.sessionId}/share`, { method: 'POST' });
      router.replace(`/session/${created.sessionId}/share`);
    } catch (err) {
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
  const b = bill.data as Bill & { parsedTotalPence?: number };
  const busy = amend.isPending || createSession.isPending;
  const existingSessionId = existingSessionIdFromError(createSession.error);
  const printed = b.parsedTotalPence;
  const mismatch = printed !== undefined && printed !== totalPence;
  const sub = items.length === 0
    ? 'Nothing read. Add the items yourself, or scan again.'
    : [b.venue?.name, `${items.length} ${items.length === 1 ? 'item' : 'items'}`, mismatch ? `receipt says ${formatGBP(printed)}` : printed !== undefined ? 'matches the receipt' : null].filter(Boolean).join(' · ');
  // No printed total to check against (a cut-off photo, usually). Only
  // before sharing: once guests are claiming, retaking the photo would
  // throw their claims away.
  const noTotal = !isMidSession && items.length > 0 && printed === undefined;
  const servicePct = subtotalPence > 0 && servicePence > 0 ? ` ${Math.round((servicePence / subtotalPence) * 1000) / 10}%` : '';

  return (
    <>
      <Page sub>
        {isMidSession ? <BackLink href={`/session/${sessionId}`}>Bill</BackLink> : <BackLink href="/">Bills</BackLink>}
        <Title title={isMidSession ? 'Fix the bill' : 'Review bill'} sub={sub} />

        {noTotal ? (
          <Notice tone="warn" title="No total on the photo">
            Bottom cut off? We can&rsquo;t check the sum.{' '}
            <button type="button" className="link-btn" onClick={() => router.push('/capture')}>
              Retake photo
            </button>
          </Notice>
        ) : null}

        <Box>
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
              <RowButton
                key={it.draftId}
                onClick={() => startEditing(it)}
                disabled={busy || (editing !== null)}
                action="Edit"
                title={it.quantity > 1 ? `${it.name || 'Item'} × ${it.quantity}` : it.name || 'Item'}
                sub={it.quantity > 1 ? `${formatGBP(parsePence(it.unitPricePounds))} each` : undefined}
                end={formatGBP(parsePence(it.unitPricePounds) * it.quantity)}
                chevron
              />
            ),
          )}
          <button type="button" className="row row--add" onClick={addAndEdit} disabled={busy || editing !== null}>
            <PlusIcon />Add item
          </button>
        </Box>

        <Totals>
          <TotalLine k="Subtotal" v={formatGBP(subtotalPence)} />
          {editing === 'service' ? (
            <MoneyEditor label="Service" value={servicePounds} onChange={setServicePounds} onDone={() => setEditing(null)} />
          ) : (
            <TotalLine
              k={<>Service{servicePct} · <button type="button" className="link-btn" onClick={() => setEditing('service')} disabled={editing !== null} aria-label="Change service charge">change</button></>}
              v={formatGBP(servicePence)}
            />
          )}
          {editing === 'tax' ? (
            <MoneyEditor label="Tax" value={taxPounds} onChange={setTaxPounds} onDone={() => setEditing(null)} />
          ) : (
            <TotalLine
              tone={taxPence > 0 ? undefined : 'mute'}
              k={<>Tax · <button type="button" className="link-btn" onClick={() => setEditing('tax')} disabled={editing !== null} aria-label="Change tax">change</button></>}
              v={taxPence > 0 ? formatGBP(taxPence) : 'None'}
            />
          )}
          <TotalLine tone="total" k="Total" v={formatGBP(totalPence)} />
        </Totals>

        {createSession.isError && !existingSessionId ? <Notice tone="error" title="Couldn’t start the bill.">{createSession.error.message}</Notice> : null}
        {amend.isError ? <Notice tone="error" title="Couldn’t save.">{amend.error.message}</Notice> : null}
        {existingSessionId ? <Button tone="secondary" href={`/session/${existingSessionId}`} replace>Open the existing bill</Button> : null}
      </Page>
      <ActionBar>
        {isMidSession ? (
          <Button grow busy={busy} disabled={editing !== null || !isDirty} onClick={onSaveMidSession}>{isDirty ? 'Save' : 'No changes'}</Button>
        ) : (
          <Button grow busy={busy || fee.isFetching} disabled={editing !== null || items.length === 0} onClick={onShare}>
            {feeDue !== null ? `Pay ${formatGBP(feeDue)} fee & get QR code` : 'Continue'}
          </Button>
        )}
      </ActionBar>
    </>
  );
}

function ItemEditor({ item, claimed, onChange, onDone, onCancel, onRemove }: {
  item: DraftItem; claimed: number; onChange: (p: Partial<DraftItem>) => void; onDone: () => void; onCancel: () => void; onRemove: () => void;
}) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onDone(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
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
            <button type="button" aria-label="One fewer" disabled={item.quantity <= minQty} onClick={() => onChange({ quantity: Math.max(minQty, item.quantity - 1) })}>−</button>
            <span aria-live="polite">{item.quantity}</span>
            <button type="button" aria-label="One more" onClick={() => onChange({ quantity: item.quantity + 1 })}>+</button>
          </div>
        </div>
      </div>
      {claimed > 0 ? <p className="field__hint">{claimed} already claimed, so it can’t go below {claimed}.</p> : null}
      <div className="btn-row btn-row--end">
        <Button tone="text" small onClick={onRemove} disabled={claimed > 0} className={claimed > 0 ? undefined : 'btn--text-danger'}>Remove</Button>
        <span style={{ flex: 1 }} />
        <Button tone="secondary" small onClick={onCancel}>Cancel</Button>
        <Button small onClick={onDone}>Done</Button>
      </div>
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
