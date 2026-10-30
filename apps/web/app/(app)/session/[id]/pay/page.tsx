'use client';

/**
 * Pay the host: the amount, one-tap Monzo/Revolut if they have them, the
 * bank details to copy, then "I've sent it". The lead has no pay page
 * any more — their table covers it.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ApiError, type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useInitiatePayment } from '@gdp/core/api/hooks/useInitiatePayment';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useMarkPaymentPaid } from '@gdp/core/api/hooks/usePaymentActions';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { monzoPayUrl, revolutPayUrl } from '@gdp/core/lib/quickPay';
import { clearSessionPayout } from '@gdp/core/lib/sessionPayout';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { copyText } from '@/lib/clipboard';
import { Back, Backdrop, Btn, Centre, CopyIcon, External, Fab, Hero, List, Notice, Screen, Sheet, Spin, Tick, TopBar, firstName } from '@/components/glass';
import { owedFor } from '../guest';

type Instructions = components['schemas']['PaymentInstructions'];
type ManualInstructions = Extract<Instructions, { type: 'manual_transfer' }>;

export default function PayPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId);
  const payout = useSessionPayout(id);
  const initiate = useInitiatePayment(id);
  const markPaid = useMarkPaymentPaid(id);
  const [instructions, setInstructions] = useState<ManualInstructions | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const s = session.data;
  const mine = s?.participants.find((p) => p.userId === me.data?.userId);
  const isCreator = !!s && !!me.data && s.creatorUserId === me.data.userId;
  const status = mine?.payment.status;

  // Open the payment as soon as the guest lands here, so the reference
  // is ready by the time they've opened their banking app.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !mine || isCreator) return;
    if (status !== 'unpaid' && status !== 'failed') return;
    started.current = true;
    initiate.mutate(undefined, {
      onSuccess: (res) => {
        if (res.instructions.type === 'manual_transfer') setInstructions(res.instructions);
        else if (res.instructions.type === 'redirect') window.open(res.instructions.url, '_blank', 'noopener');
      },
    });
  }, [mine, isCreator, status, initiate]);

  // The lead's table replaces their old collecting screen.
  useEffect(() => { if (isCreator) router.replace(`/session/${id}`); }, [isCreator, router, id]);
  // Once the host has the money, this device no longer needs their bank details.
  useEffect(() => { if (status === 'succeeded') clearSessionPayout(id); }, [status, id]);

  if (session.isPending || me.isPending || (session.isSuccess && bill.isPending)) return <Centre><Spin /></Centre>;
  if (session.isError) return <Centre><Notice error title="Couldn’t load the bill.">{session.error.message}</Notice></Centre>;
  if (!s || !bill.data || !mine || isCreator) return null;

  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const amount = owedFor(s, bill.data, mine);
  // ADR-0002: the details the lead shared in the QR are the source of truth.
  const bd = payout.data ?? instructions?.bankDetails;
  const reference = instructions?.reference ?? (status === 'pending' ? `gdp-${id.slice(0, 8)}` : undefined);
  const sentAt = mine.payment.status === 'pending' ? mine.payment.payerClaimedPaidAt : undefined;
  const monzo = payout.data?.monzoHandle ? monzoPayUrl(payout.data.monzoHandle, amount, reference) : null;
  const revolut = payout.data?.revolutTag ? revolutPayUrl(payout.data.revolutTag) : null;
  const startError = initiate.error instanceof ApiError && initiate.error.code === 'PAYOUT_ACCOUNT_REQUIRED' && bd ? null : initiate.error?.message;

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1400); }
  };
  const fmtSort = (sc: string) => sc.replace(/(\d{2})(?=\d)/g, '$1-');

  const canSend = mine.payment.status === 'pending' && !sentAt;
  const foot = status === 'succeeded'
    ? <Btn href={`/session/${id}`} replace>Done</Btn>
    : sentAt
      ? <Btn tone="light" href={`/session/${id}`} replace>Back to the table</Btn>
      : status === 'failed'
        ? <Btn busy={initiate.isPending} onClick={() => { started.current = false; initiate.reset(); }}>Try again</Btn>
        : <Btn busy={markPaid.isPending} disabled={!canSend} onClick={() => mine.payment.status === 'pending' && markPaid.mutate(mine.payment.paymentId, { onSuccess: () => router.replace(`/session/${id}`) })}>I’ve sent it</Btn>;

  return (
    <Screen>
      <Backdrop billId={s.billId} tone="deep" />
      <TopBar left={sentAt || status === 'succeeded' ? undefined : <Fab href={`/session/${id}`} label="Back" icon={<Back />} replace />} title={bill.data.venue?.name} />
      <Sheet
        head={
          <div className="g-sheet__head">
            <Hero
              kicker={status === 'succeeded' ? `${hostFirst} has your` : sentAt ? `sent to ${hostFirst}` : `pay ${hostFirst}`}
              amount={formatGBP(amount)}
              note={status === 'succeeded' ? undefined : sentAt ? `Waiting for ${hostFirst} to confirm` : 'Straight to their bank'}
            />
          </div>
        }
        foot={foot}
      >
        {status === 'succeeded' ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}><div className="g-done g-rise"><Tick size={36} /></div></div>
        ) : (
          <>
            {monzo || revolut ? (
              <div style={{ display: 'flex', gap: 8 }}>
                {monzo ? <a className="g-btn g-btn--light" style={{ flex: 1 }} href={monzo} target="_blank" rel="noopener noreferrer">Monzo <External /></a> : null}
                {revolut ? <a className="g-btn g-btn--light" style={{ flex: 1 }} href={revolut} target="_blank" rel="noopener noreferrer">Revolut <External /></a> : null}
              </div>
            ) : null}
            {bd ? (
              <List>
                <CopyRow k="Name" v={bd.accountHolderName} copied={copied === 'n'} onCopy={() => copy('n', bd.accountHolderName)} />
                <CopyRow k="Sort code" v={fmtSort(bd.sortCode)} copied={copied === 's'} onCopy={() => copy('s', bd.sortCode)} />
                <CopyRow k="Account" v={bd.accountNumber} copied={copied === 'a'} onCopy={() => copy('a', bd.accountNumber)} />
                {reference ? <CopyRow k="Reference" v={reference} copied={copied === 'r'} onCopy={() => copy('r', reference)} /> : null}
              </List>
            ) : initiate.isPending ? (
              <Centre><Spin /></Centre>
            ) : (
              <Notice title={`No bank details from ${hostFirst} yet.`}>Scan their QR again with this phone.</Notice>
            )}
            {startError ? <Notice error>{startError}</Notice> : null}
            {markPaid.isError ? <Notice error>{markPaid.error.message}</Notice> : null}
          </>
        )}
      </Sheet>
    </Screen>
  );
}

function CopyRow({ k, v, copied, onCopy }: { k: string; v: string; copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" className="g-row g-row--kv" style={{ background: 'none', border: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }} onClick={onCopy} aria-label={`Copy ${k.toLowerCase()}`}>
      <span>{k}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--g-ink)', fontWeight: 600 }}>
        {v}
        <span style={{ color: copied ? 'var(--g-accent)' : 'var(--g-mute)', display: 'inline-flex' }}>{copied ? <Tick size={14} /> : <CopyIcon />}</span>
      </span>
    </button>
  );
}
