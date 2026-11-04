'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { shareSession, useCreateSession } from '@gdp/core/api/hooks/useSession';
import { creditDate, useStartTableFee, useTableFeeStatus } from '@gdp/core/api/hooks/useTableFee';
import { StripeForm, sessionIdOf, stripePromise } from '@/components/StripeForm';
import { formatGBP } from '@gdp/core/lib/money';
import { ActionBar, BackLink, Box, Button, Centre, Notice, Page, QrIcon, Row, Spinner, TickIcon, Title } from '@/components/ui';

const pounds = (pence: number) => `£${pence % 100 === 0 ? pence / 100 : (pence / 100).toFixed(2)}`;

/** How long to wait for the payment to land before offering a retry. */
const WAIT_MS = 30_000;

/**
 * F3: the lead puts a £1 hold on their card in Stripe's embedded form (#165),
 * then goes back to share the bill. Nothing is taken now; at close the
 * guests' part is taken and the rest released. Card details stay inside
 * Stripe's iframe.
 */
export default function TableFeePage({ params }: { params: Promise<{ billId: string }> }) {
  const { billId } = use(params);
  const router = useRouter();
  // Back from a redirect-based payment method: Stripe adds ?session_id=…
  const returnedId = useSearchParams().get('session_id');
  const [confirmed, setConfirmed] = useState(returnedId !== null);
  const [checkoutSessionId, setCheckoutSessionId] = useState<string | null>(returnedId);
  // Stop polling after WAIT_MS so a lost webhook can't spin forever.
  const [slow, setSlow] = useState(false);
  const status = useTableFeeStatus(billId, { poll: confirmed && !slow, checkoutSessionId });
  // A hold, an exempt lead or this month's credit are as good as paid.
  const s = status.data?.status;
  const paid = s === 'held' || s === 'paid' || s === 'waived' || s === 'free' || s === 'credit';

  useEffect(() => {
    if (!confirmed || paid || slow) return;
    const t = setTimeout(() => setSlow(true), WAIT_MS);
    return () => clearTimeout(t);
  }, [confirmed, paid, slow]);

  // Paid: open the table and go straight to the QR code (F4).
  const createSession = useCreateSession();
  const started = useRef(false);
  useEffect(() => {
    if (!paid || started.current) return;
    started.current = true;
    const next = s === 'held' || s === 'paid' ? 'fee' : s === 'free' || s === 'credit' ? 'credit' : '1';
    const shareAndGo = async (sessionId: string) => {
      await shareSession(sessionId, checkoutSessionId);
      router.replace(`/session/${sessionId}/share?new=${next}`);
    };
    void (async () => {
      let sessionId: string | undefined;
      try {
        sessionId = (await createSession.mutateAsync({ billId })).sessionId;
      } catch (err) {
        // A table not yet shared (an earlier try stopped at the fee): share that one.
        const d = err instanceof ApiError ? (err.details as { sessionId?: unknown } | undefined) : undefined;
        if (typeof d?.sessionId === 'string') sessionId = d.sessionId;
      }
      if (!sessionId) { router.replace(`/confirm-bill/${billId}`); return; }
      try {
        await shareAndGo(sessionId);
      } catch {
        router.replace(`/session/${sessionId}`);
      }
    })();
  }, [paid, billId, router, createSession, checkoutSessionId, s]);

  const back = <BackLink href={`/confirm-bill/${billId}`}>Platform fee</BackLink>;

  if (!stripePromise) {
    return (
      <Page sub>
        {back}
        <Notice tone="error" title="Payments aren’t set up.">Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.</Notice>
      </Page>
    );
  }
  if (status.isPending) return <Centre><Spinner /></Centre>;
  if (status.isError) {
    return (
      <Page sub>
        {back}
        <Notice tone="error" title="Couldn’t load the fee.">{status.error.message}</Notice>
      </Page>
    );
  }
  if (status.data === null) {
    return (
      <Page sub>
        {back}
        <Notice tone="error" title="Payments aren’t set up.">The API has no STRIPE_SECRET_KEY.</Notice>
      </Page>
    );
  }
  if (confirmed || paid) {
    const stage = paid ? 'qr' : slow ? 'slow' : 'paying';
    return (
      <Page>
        <div className={`box pay-wait pay-wait--${stage}`} role="status" aria-live="polite">
          <div className="pay-wait__mark" aria-hidden="true">
            {stage === 'qr' ? <QrIcon /> : stage === 'slow' ? '!' : <CardIcon />}
            {stage === 'paying' ? <span className="pay-wait__ring" /> : null}
            {stage === 'qr' ? <span className="pay-wait__done"><TickIcon size={14} /></span> : null}
          </div>
          <h1 className="pay-wait__title">
            {stage === 'qr'
              ? status.data.status === 'held' ? `${pounds(status.data.amountPence)} hold placed` : status.data.status === 'paid' ? `${pounds(status.data.amountPence)} platform fee paid` : status.data.status === 'free' ? '1 credit spent' : 'No fee'
              : stage === 'slow' ? 'Still checking' : `Holding ${pounds(status.data.amountPence)}`}
          </h1>
          <p className="muted">
            {stage === 'qr'
              ? 'Making your QR code'
              : stage === 'slow'
                ? 'Stripe hasn’t confirmed yet.'
                : 'Confirming with your bank'}
          </p>
          <div className="pay-wait__bar" aria-hidden="true">
            <span className={stage === 'qr' ? 'on' : 'busy'} />
            <span className={stage === 'qr' ? 'busy' : ''} />
          </div>
        </div>
        {stage === 'slow' ? (
          <ActionBar stack>
            <Button
              onClick={() => {
                setSlow(false);
                void status.refetch();
              }}
            >
              Check again
            </Button>
            <Button tone="secondary" href={`/confirm-bill/${billId}`}>Back to the bill</Button>
          </ActionBar>
        ) : (
          <p className="muted small" style={{ textAlign: 'center' }}>Don’t close this page.</p>
        )}
      </Page>
    );
  }

  return (
    <Page sub>
      {back}
      <Title
        title="Platform fee"
        sub={status.data.status === 'unpaid' && status.data.nextCreditOn
          ? `No credits left this month. Next one ${creditDate(status.data.nextCreditOn)}.`
          : 'Then your QR code'}
      />
      <Box><Row title="Platform fee hold" end={formatGBP(status.data.amountPence)} /></Box>
      <p className="small muted">
        Or <Link href={`/credits?returnTo=${encodeURIComponent(`/confirm-bill/${billId}`)}`}>buy 10 credits for £5</Link>: bills free for everyone.
      </p>
      <FeeForm
        billId={billId}
        onConfirmed={(id) => {
          setCheckoutSessionId(id);
          setConfirmed(true);
        }}
      />
    </Page>
  );
}

function FeeForm({ billId, onConfirmed }: { billId: string; onConfirmed: (checkoutSessionId: string | null) => void }) {
  const start = useStartTableFee();
  // One Checkout Session per visit, even when React runs effects twice in dev.
  const clientSecret = useRef<Promise<string> | null>(null);
  if (clientSecret.current === null) {
    clientSecret.current = start.mutateAsync({ billId }).then((r) => r.client_secret);
  }

  if (start.isError) {
    return (
      <>
        <Notice tone="error" title="Couldn’t start the payment.">{start.error.message}</Notice>
        <Button tone="secondary" href={`/confirm-bill/${billId}`}>Back to the bill</Button>
      </>
    );
  }

  return (
    <StripeForm
      clientSecret={clientSecret.current}
      onConfirmed={() => {
        void clientSecret.current?.then((secret) => onConfirmed(sessionIdOf(secret)));
      }}
      note="Nothing taken now · Your guests pay it back · Released if nobody joins"
    />
  );
}

const CardIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M7 15h3" />
  </svg>
);
