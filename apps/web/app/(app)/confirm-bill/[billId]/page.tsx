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
import {
  Back, Backdrop, Btn, Centre, Close, Fab, KV, List, MiniBtn, Notice, Pencil, Plus, Price, Row, RowBody, Screen, Sheet, Spin, Tag, TopBar,
} from '@/components/glass';

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

export default function ConfirmBillPage() {
  return <Suspense fallback={<Centre><Spin /></Centre>}><CheckBill /></Suspense>;
}

/**
 * "Check the bill": the scanned lines over the photo. Tap a line to fix
 * it; each fix saves when the editor closes. Service and tax are rows
 * in the totals card and edit the same way.
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

  if (bill.isPending || (bill.isSuccess && !hydrated)) return <Centre><Spin /></Centre>;
  if (bill.isError) {
    return <Centre><Notice error title="Couldn't load the bill.">{bill.error.message}</Notice><Btn tone="ghost" href="/" replace>Back</Btn></Centre>;
  }
  const b = bill.data as Bill & { parsedTotalPence?: number };
  const busy = amend.isPending || createSession.isPending;
  const existingSessionId = existingSessionIdFromError(createSession.error);
  const printed = b.parsedTotalPence;
  const mismatch = printed !== undefined && printed !== totalPence;
  const sub = items.length === 0
    ? 'Nothing read. Add the lines yourself, or retake.'
    : [b.venue?.name, `${items.length} ${items.length === 1 ? 'item' : 'items'}`, mismatch ? `receipt says ${formatGBP(printed)}` : printed !== undefined ? 'matches the receipt' : null].filter(Boolean).join(' · ');

  return (
    <Screen>
      <Backdrop billId={billId} tone="dim" />
      <TopBar
        left={<Fab href={isMidSession ? `/session/${sessionId}` : '/'} label={isMidSession ? 'Back' : 'Cancel'} icon={isMidSession ? <Back /> : <Close />} replace />}
        right={isMidSession ? undefined : <Fab href="/" label="Retake" replace>Retake</Fab>}
      />
      <Sheet
        size="mid"
        title={isMidSession ? 'Fix the bill' : 'Check the bill'}
        sub={sub}
        foot={
          <>
            {createSession.isError && !existingSessionId ? <Notice error title="Couldn't start the bill.">{createSession.error.message}</Notice> : null}
            {amend.isError ? <Notice error title="Couldn't save.">{amend.error.message}</Notice> : null}
            {existingSessionId ? <Btn tone="ghost" href={`/session/${existingSessionId}`} replace>Open the existing bill</Btn> : null}
            {isMidSession ? (
              <Btn busy={busy} disabled={editing !== null || !isDirty} onClick={onSaveMidSession}>{isDirty ? 'Save' : 'No changes'}</Btn>
            ) : (
              <Btn busy={busy} disabled={editing !== null || items.length === 0} onClick={onShare}>Share with the table</Btn>
            )}
          </>
        }
      >
        <List>
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
              <Row key={it.draftId} onClick={() => startEditing(it)} disabled={busy} ariaLabel={`Edit ${it.name || 'item'}`}>
                <RowBody name={it.name || 'Item'} sub={it.quantity > 1 ? `${formatGBP(parsePence(it.unitPricePounds))} each` : undefined} />
                {it.quantity > 1 ? <span className="g-qty">{it.quantity}</span> : null}
                <Price>{formatGBP(parsePence(it.unitPricePounds) * it.quantity)}</Price>
                <span style={{ color: 'var(--g-mute-2)', display: 'flex' }} aria-hidden><Pencil /></span>
              </Row>
            ),
          )}
          <Row onClick={addAndEdit} disabled={busy || editing !== null} className="g-row--add"><Plus />Add a line</Row>
        </List>

        <List>
          <KV k="Subtotal" v={formatGBP(subtotalPence)} />
          {editing === 'service' ? (
            <MoneyEditor label="Service" value={servicePounds} onChange={setServicePounds} onDone={() => setEditing(null)} />
          ) : (
            <Row onClick={() => setEditing('service')} className="g-row--kv" ariaLabel="Edit service charge">
              <span>Service{subtotalPence > 0 && servicePence > 0 ? ` ${Math.round((servicePence / subtotalPence) * 1000) / 10}%` : ''}</span>
              <Tag tone="accent">{formatGBP(servicePence)}</Tag>
            </Row>
          )}
          {editing === 'tax' ? (
            <MoneyEditor label="Tax" value={taxPounds} onChange={setTaxPounds} onDone={() => setEditing(null)} />
          ) : taxPence > 0 || editing === null ? (
            <Row onClick={() => setEditing('tax')} className="g-row--kv" ariaLabel="Edit tax">
              <span>Tax</span>
              <span>{taxPence > 0 ? formatGBP(taxPence) : <span style={{ color: 'var(--g-mute-2)', fontWeight: 500 }}>none</span>}</span>
            </Row>
          ) : null}
        </List>
        <List strong><KV k="Total" v={formatGBP(totalPence)} total /></List>
      </Sheet>
    </Screen>
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
    <div style={{ padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--g-line)', background: 'rgba(61,220,151,0.06)' }} onKeyDown={onKey}>
      <input className="g-input" aria-label="Item name" value={item.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="What was it?" autoCorrect="off" autoFocus style={{ height: 48 }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div className="g-input-wrap" style={{ flex: 1, minWidth: 0, height: 48 }}>
          <span className="g-input-wrap__prefix">£</span>
          <input aria-label="Price each" style={{ minWidth: 0, width: '100%' }} value={item.unitPricePounds} onChange={(e) => onChange({ unitPricePounds: e.target.value })} onBlur={() => onChange({ unitPricePounds: pounds(parsePence(item.unitPricePounds)) })} onFocus={(e) => e.target.select()} inputMode="decimal" placeholder="0.00" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 40, borderRadius: 20, background: 'var(--g-fill-2)', padding: '0 2px', flex: 'none' }}>
          <button type="button" className="g-mini-btn" style={{ border: 0, width: 36, padding: 0, fontSize: 18 }} aria-label="One fewer" disabled={item.quantity <= minQty} onClick={() => onChange({ quantity: Math.max(minQty, item.quantity - 1) })}>−</button>
          <span style={{ minWidth: 24, textAlign: 'center', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{item.quantity}</span>
          <button type="button" className="g-mini-btn" style={{ border: 0, width: 36, padding: 0, fontSize: 18 }} aria-label="One more" onClick={() => onChange({ quantity: item.quantity + 1 })}>+</button>
        </div>
      </div>
      {claimed > 0 ? <div className="g-foot-note" style={{ textAlign: 'left' }}>{claimed} already claimed, so it can&apos;t go below {claimed}.</div> : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <MiniBtn onClick={onRemove} disabled={claimed > 0} style={{ color: claimed > 0 ? undefined : 'var(--g-danger)', height: 40 }}>Remove</MiniBtn>
        <span style={{ flex: 1 }} />
        <MiniBtn onClick={onCancel} style={{ height: 40 }}>Cancel</MiniBtn>
        <MiniBtn solid onClick={onDone} style={{ height: 40, padding: '0 16px' }}>Done</MiniBtn>
      </div>
    </div>
  );
}

function MoneyEditor({ label, value, onChange, onDone }: { label: string; value: string; onChange: (v: string) => void; onDone: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--g-line)' }}>
      <span style={{ flex: 1, fontSize: 15, color: 'var(--g-ink-2)' }}>{label}</span>
      <div className="g-input-wrap" style={{ width: 130, height: 44 }}>
        <span className="g-input-wrap__prefix">£</span>
        <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => onChange(pounds(parsePence(value)))} onFocus={(e) => e.target.select()} inputMode="decimal" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onDone(); } }} />
      </div>
      <MiniBtn solid onClick={onDone} style={{ height: 40 }}>Done</MiniBtn>
    </div>
  );
}
