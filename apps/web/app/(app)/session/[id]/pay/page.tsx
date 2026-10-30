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
import { ActionBar, BackLink, Box, Button, Centre, CopyIcon, Notice, Page, Spinner, TickIcon, Title, firstName } from '@/components/ui';
import { owedFor } from '../guest';

type Instructions = components['schemas']['PaymentInstructions'];
type ManualInstructions = Extract<Instructions, { type: 'manual_transfer' }>;

export default function PayPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);
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

  if (session.isPending || me.isPending || (session.isSuccess && bill.isPending)) return <Centre><Spinner /></Centre>;
  if (session.isError) return <Centre><Notice tone="error" title="Couldn’t load the bill.">{session.error.message}</Notice></Centre>;
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
  const done = status === 'succeeded' || !!sentAt;
  const action = status === 'succeeded'
    ? <Button grow href={`/session/${id}`} replace>Done</Button>
    : sentAt
      ? <Button grow tone="secondary" href={`/session/${id}`} replace>Back to the bill</Button>
      : status === 'failed' || (status === 'unpaid' && startError)
        ? <Button grow busy={initiate.isPending} onClick={() => { started.current = false; initiate.reset(); }}>Try again</Button>
        : <Button grow busy={markPaid.isPending} disabled={!canSend} onClick={() => mine.payment.status === 'pending' && markPaid.mutate(mine.payment.paymentId, { onSuccess: () => router.replace(`/session/${id}`) })}>I’ve paid</Button>;

  return (
    <>
      <Page sub>
        {done ? <BackLink href="/">Bills</BackLink> : <BackLink href={`/session/${id}`}>Your items</BackLink>}
        <Title
          title={status === 'succeeded' ? `${hostFirst} has your ${formatGBP(amount)}` : sentAt ? `You’ve paid ${hostFirst} ${formatGBP(amount)}` : `Pay ${hostFirst} ${formatGBP(amount)}`}
          sub={status === 'succeeded' ? bill.data.venue?.name : sentAt ? `Waiting for ${hostFirst} to confirm.` : 'By bank transfer. Tap a detail to copy it.'}
        />
        {done ? null : (
          <>
            {bd ? (
              <Box>
                <CopyRow k="Name" v={bd.accountHolderName} copied={copied === 'n'} onCopy={() => copy('n', bd.accountHolderName)} />
                <CopyRow k="Sort code" v={fmtSort(bd.sortCode)} copied={copied === 's'} onCopy={() => copy('s', bd.sortCode)} />
                <CopyRow k="Account no." v={bd.accountNumber} label="account number" copied={copied === 'a'} onCopy={() => copy('a', bd.accountNumber)} />
                {reference ? <CopyRow k="Reference" v={reference} copied={copied === 'r'} onCopy={() => copy('r', reference)} /> : null}
              </Box>
            ) : initiate.isPending ? (
              <Spinner />
            ) : (
              <Notice title={`No bank details from ${hostFirst} yet.`}>Scan their QR code again with this phone.</Notice>
            )}
            {monzo || revolut ? (
              <div className="btn-row">
                {monzo ? <a className="btn btn--secondary" href={monzo} target="_blank" rel="noopener noreferrer">Pay with Monzo</a> : null}
                {revolut ? <a className="btn btn--secondary" href={revolut} target="_blank" rel="noopener noreferrer">Pay with Revolut</a> : null}
              </div>
            ) : null}
            {startError ? <Notice tone="error">{startError}</Notice> : null}
            {markPaid.isError ? <Notice tone="error">{markPaid.error.message}</Notice> : null}
          </>
        )}
      </Page>
      <ActionBar>{action}</ActionBar>
    </>
  );
}

function CopyRow({ k, v, label, copied, onCopy }: { k: string; v: string; label?: string; copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" className="row" onClick={onCopy} aria-label={`Copy ${label ?? k.toLowerCase()}`}>
      <span className="row__main"><span className="row__sub">{k}</span><span className="row__title" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span></span>
      <span style={{ color: copied ? 'var(--ok-ink)' : 'var(--mute)', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
        {copied ? <><TickIcon size={18} />Copied</> : <CopyIcon />}
      </span>
    </button>
  );
}
