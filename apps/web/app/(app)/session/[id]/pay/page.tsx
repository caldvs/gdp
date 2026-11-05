'use client';

/**
 * Pay the host: the amount, one-tap Monzo/Revolut if they have them, the
 * bank details to copy, then "I've sent it". The lead has no pay page
 * any more — their table covers it.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { type components } from '@gdp/core/api';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useInitiatePayment } from '@gdp/core/api/hooks/useInitiatePayment';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useMarkPaymentPaid } from '@gdp/core/api/hooks/usePaymentActions';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { monzoPayUrl, revolutPayUrl } from '@gdp/core/lib/quickPay';
import { clearSessionPayout } from '@gdp/core/lib/sessionPayout';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { usePayoutVerdict } from '@gdp/core/lib/usePayoutCheck';
import { copyText } from '@/lib/clipboard';
import { ActionBar, BackLink, Box, Button, Centre, CopyIcon, Dialog, Notice, Page, Spinner, TickIcon, Title, firstName } from '@/components/ui';
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
  // "Are you sure you've paid?" before it's marked (4 Nov).
  const [confirming, setConfirming] = useState(false);

  const s = session.data;
  // #151: details from a link that don't match the lead's are never shown.
  const verdict = usePayoutVerdict(id, payout.data, s?.payoutCheck);
  const linkPayout = verdict === 'mismatch' || verdict === 'checking' ? null : payout.data;
  const mine = s?.participants.find((p) => p.userId === me.data?.userId);
  const isCreator = !!s && !!me.data && s.creatorUserId === me.data.userId;
  // #121: a guest may pay more than once; this page pays what's due now
  // (all of it, or the top-up after claiming more).
  const l = s && mine && bill.data ? ledger(mine, owedFor(s, bill.data, mine)) : null;
  const due = l?.duePence ?? 0;

  // Open the payment as soon as the guest lands here, so the reference
  // is ready by the time they've opened their banking app. The API hands
  // back the one already open if it's still for this amount.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !mine || isCreator || !l) return;
    if (due <= 0) return;
    started.current = true;
    initiate.mutate(undefined, {
      onSuccess: (res) => setInstructions(res.instructions),
    });
  }, [mine, isCreator, l, due, initiate]);

  // The lead's table replaces their old collecting screen.
  useEffect(() => { if (isCreator) router.replace(`/session/${id}`); }, [isCreator, router, id]);
  // Once the host has all the money, this device no longer needs their bank details.
  const settled = !!l?.settled;
  useEffect(() => { if (settled) clearSessionPayout(id); }, [settled, id]);

  if (session.isPending || me.isPending || (session.isSuccess && bill.isPending)) return <Centre><Spinner /></Centre>;
  if (session.isError) return <Centre><Notice tone="error" title="Couldn’t load the bill.">{session.error.message}</Notice></Centre>;
  if (!s || !bill.data || !mine || isCreator) return null;

  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const lg = l!;
  // The payment open on this page (not sent yet), else what's due.
  const open = lg.draft && lg.draft.amountPence === due ? lg.draft : undefined;
  const amount = open?.amountPence ?? due;
  const waitingPence = lg.waiting.reduce((a, e) => a + e.amountPence, 0);
  // ADR-0002: the details the lead shared in the QR are the source of truth.
  const bd = linkPayout ?? (verdict === 'mismatch' ? undefined : instructions?.bankDetails);
  const reference = instructions?.reference ?? (open ? `gdp-${id.slice(0, 8)}` : undefined);
  const monzo = linkPayout?.monzoHandle ? monzoPayUrl(linkPayout.monzoHandle, amount, reference) : null;
  const revolut = linkPayout?.revolutTag ? revolutPayUrl(linkPayout.revolutTag) : null;
  const startError = initiate.error?.message;

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1400); }
  };
  const fmtSort = (sc: string) => sc.replace(/(\d{2})(?=\d)/g, '$1-');

  const done = due <= 0;
  const action = settled
    ? <Button grow href={`/session/${id}`} replace>Done</Button>
    : done
      ? <Button grow tone="secondary" href={`/session/${id}`} replace>Back to the bill</Button>
      : startError
        ? <Button grow busy={initiate.isPending} onClick={() => { started.current = false; initiate.reset(); }}>Try again</Button>
        : <Button grow busy={markPaid.isPending} disabled={!open} onClick={() => setConfirming(true)}>I’ve paid</Button>;
  const confirmPaid = () => {
    if (!open) return;
    markPaid.mutate(open.paymentId, { onSuccess: () => router.replace(`/session/${id}`), onSettled: () => setConfirming(false) });
  };

  return (
    <>
      <Page sub>
        {done ? (me.data?.guestSessionId ? null : <BackLink href="/">Bills</BackLink>) : <BackLink href={`/session/${id}`}>Your items</BackLink>}
        {/* #198: the tick on the row isn't read out; this is. */}
        <div className="vh" role="status">{copied ? `${COPIED[copied] ?? 'Detail'} copied` : ''}</div>
        <Title
          title={settled ? `${hostFirst} has your ${formatGBP(lg.confirmedPence)}` : done ? `You’ve paid ${hostFirst} ${formatGBP(lg.sentPence)}` : `Pay ${hostFirst}`}
          sub={settled ? bill.data.venue?.name : done ? (waitingPence > 0 ? `Waiting for ${hostFirst} to confirm.` : undefined) : lg.sentPence > 0 ? `The rest, after the ${formatGBP(lg.sentPence)} you’ve paid. By bank transfer.` : 'By bank transfer. Tap a detail to copy it.'}
        />
        {done ? null : (
          <>
            <h2 className="pay-total"><span>You pay {hostFirst}</span><b>{formatGBP(amount)}</b></h2>
            {bd ? (
              <Box list label="Bank details">
                <CopyRow k="Name" v={bd.accountHolderName} copied={copied === 'n'} onCopy={() => copy('n', bd.accountHolderName)} />
                <CopyRow k="Sort code" v={fmtSort(bd.sortCode)} copied={copied === 's'} onCopy={() => copy('s', bd.sortCode)} />
                <CopyRow k="Account no." v={bd.accountNumber} copied={copied === 'a'} onCopy={() => copy('a', bd.accountNumber)} />
                {reference ? <CopyRow k="Reference" v={reference} copied={copied === 'r'} onCopy={() => copy('r', reference)} /> : null}
              </Box>
            ) : verdict === 'mismatch' ? (
              <Notice tone="error" title={`These aren’t ${hostFirst}’s bank details.`}>Don’t pay them. Scan {hostFirst}’s own QR code.</Notice>
            ) : initiate.isPending || verdict === 'checking' ? (
              <Spinner />
            ) : (
              <Notice title={`No bank details from ${hostFirst} yet.`}>Scan their QR code again with this phone.</Notice>
            )}
            {monzo || revolut ? (
              <div className="pay-apps">
                {monzo ? <a className="btn btn--monzo" href={monzo} target="_blank" rel="noopener noreferrer"><span className="pay-apps__mark" aria-hidden="true" />Pay with Monzo</a> : null}
                {revolut ? <a className="btn btn--revolut" href={revolut} target="_blank" rel="noopener noreferrer"><span className="pay-apps__mark" aria-hidden="true" />Pay with Revolut</a> : null}
              </div>
            ) : null}
            {startError ? <Notice tone="error">{startError}</Notice> : null}
            {markPaid.isError ? <Notice tone="error">{markPaid.error.message}</Notice> : null}
          </>
        )}
      </Page>
      <ActionBar>{action}</ActionBar>
      {confirming && open ? (
        <Dialog
          id="paid-t"
          describedBy="paid-d"
          title="Are you sure you’ve paid?"
          onClose={() => setConfirming(false)}
          actions={(
            <>
              <Button tone="secondary" onClick={() => setConfirming(false)}>Not yet</Button>
              <Button busy={markPaid.isPending} onClick={confirmPaid}>Yes, I’ve paid</Button>
            </>
          )}
        >
          <p id="paid-d" className="muted">Only once {formatGBP(amount)} has left your account. {hostFirst} checks it’s arrived.</p>
        </Dialog>
      ) : null}
    </>
  );
}

const COPIED: Record<string, string> = { n: 'Name', s: 'Sort code', a: 'Account number', r: 'Reference' };

function CopyRow({ k, v, copied, onCopy }: { k: string; v: string; copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" className="row" onClick={onCopy}>
      <span className="vh">Copy </span>
      <span className="row__main"><span className="row__sub">{k}</span><span className="row__title" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span></span>
      <span style={{ color: copied ? 'var(--ok-ink)' : 'var(--mute)', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
        {copied ? <><TickIcon size={18} />Copied</> : <CopyIcon />}
      </span>
    </button>
  );
}
