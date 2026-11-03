'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loadStripe, type StripeCheckoutFormConfirmEvent } from '@stripe/stripe-js';
import { CheckoutForm, CheckoutFormProvider, useCheckoutForm } from '@stripe/react-stripe-js/checkout';
import { api, ApiError } from '@gdp/core/api';
import { useCreateSession } from '@gdp/core/api/hooks/useSession';
import { useStartTableFee, useTableFeeStatus } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { ActionBar, BackLink, Button, Centre, Notice, Page, QrIcon, Spinner, TickIcon, Title } from '@/components/ui';

// loadStripe fetches Stripe.js from js.stripe.com (never bundled), as PCI requires.
const stripePromise = STRIPE_PUBLISHABLE_KEY ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null;

// Configured in Checkout Studio.
const appearance = {
  theme: 'stripe',
  labels: 'auto',
  inputs: 'spaced',
  variables: {
    borderRadius: '4px',
    colorBackground: '#ffffff',
    colorDanger: '#df1b41',
    colorPrimary: '#d42a55',
    colorSuccess: '#00c853',
    colorText: '#222222',
    fontFamily: 'default',
    fontSizeBase: '16px',
    spacingUnit: '4px',
  },
} as const;

const pounds = (pence: number) => `£${pence % 100 === 0 ? pence / 100 : (pence / 100).toFixed(2)}`;

/** A Checkout Session's client secret is `<session id>_secret_<…>`. */
const sessionIdOf = (clientSecret: string) => clientSecret.split('_secret_')[0] ?? null;

/** How long to wait for the payment to land before offering a retry. */
const WAIT_MS = 30_000;

/**
 * F3: the lead pays the table fee in Stripe's embedded form, then goes back
 * to share the bill. Card details stay inside Stripe's iframe.
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
  // Waived: this lead's email is exempt, so it's as good as paid.
  const paid = status.data?.status === 'paid' || status.data?.status === 'waived';

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
    void (async () => {
      try {
        const created = await createSession.mutateAsync({ billId });
        await api(`/v1/sessions/${created.sessionId}/share`, { method: 'POST' });
        router.replace(`/session/${created.sessionId}/share`);
      } catch (err) {
        const d = err instanceof ApiError ? (err.details as { sessionId?: unknown } | undefined) : undefined;
        if (typeof d?.sessionId === 'string') router.replace(`/session/${d.sessionId}`);
        else router.replace(`/confirm-bill/${billId}`);
      }
    })();
  }, [paid, billId, router, createSession]);

  const back = <BackLink href={`/confirm-bill/${billId}`}>Table fee</BackLink>;

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
            {stage === 'qr' ? 'Paid' : stage === 'slow' ? 'Still checking' : 'Confirming payment'}
          </h1>
          <p className="muted">
            {stage === 'qr'
              ? 'Making your QR code'
              : stage === 'slow'
                ? 'Stripe hasn’t confirmed yet.'
                : `${pounds(status.data.amountPence)} table fee`}
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
      <Title title={`Pay ${pounds(status.data.amountPence)} fee`} sub="Then your QR code" />
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
    <CheckoutFormProvider stripe={stripePromise} options={{ clientSecret: clientSecret.current, appearance }}>
      <Form
        onConfirmed={() => {
          void clientSecret.current?.then((secret) => onConfirmed(sessionIdOf(secret)));
        }}
      />
    </CheckoutFormProvider>
  );
}

function Form({ onConfirmed }: { onConfirmed: () => void }) {
  const state = useCheckoutForm();
  const [error, setError] = useState<string | null>(null);

  if (state.type === 'error') {
    return <Notice tone="error" title="Couldn’t load the payment form.">{state.error.message}</Notice>;
  }

  const onConfirm = async (event: StripeCheckoutFormConfirmEvent) => {
    if (state.type !== 'success') return;
    setError(null);
    try {
      // Cards and wallets finish here; only redirect-based methods leave the page.
      const result = await state.checkout.confirm({ formConfirmEvent: event, redirect: 'if_required' });
      if (result.type === 'success') onConfirmed();
    } catch (err) {
      // The form shows its own messages for declines; this is for anything else.
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <>
      <CheckoutForm options={{ layout: 'expanded' }} onConfirm={onConfirm} />
      {error ? <Notice tone="error" title="Payment didn’t go through.">{error}</Notice> : null}
    </>
  );
}

const CardIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M7 15h3" />
  </svg>
);
