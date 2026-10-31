'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loadStripe, type StripeCheckoutFormConfirmEvent } from '@stripe/stripe-js';
import { CheckoutForm, CheckoutFormProvider, useCheckoutForm } from '@stripe/react-stripe-js/checkout';
import { useStartTableFee, useTableFeeStatus } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { BackLink, Button, Centre, Notice, Page, Spinner, Title } from '@/components/ui';

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
    colorPrimary: '#0570de',
    colorSuccess: '#00c853',
    colorText: '#30313d',
    fontFamily: 'default',
    fontSizeBase: '16px',
    spacingUnit: '4px',
  },
} as const;

const pounds = (pence: number) => `£${pence % 100 === 0 ? pence / 100 : (pence / 100).toFixed(2)}`;

/**
 * F3: the lead pays the table fee in Stripe's embedded form, then goes back
 * to share the bill. Card details stay inside Stripe's iframe.
 */
export default function TableFeePage({ params }: { params: Promise<{ billId: string }> }) {
  const { billId } = use(params);
  const router = useRouter();
  // Back from a redirect-based payment method: Stripe adds ?session_id=…
  const returned = useSearchParams().get('session_id') !== null;
  const [confirmed, setConfirmed] = useState(returned);
  const status = useTableFeeStatus(billId, { poll: confirmed });
  const paid = status.data?.status === 'paid';

  useEffect(() => {
    if (paid) router.replace(`/confirm-bill/${billId}?fee=paid`);
  }, [paid, billId, router]);

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
  if (confirmed || paid) {
    return <Centre><Spinner label="Confirming payment" /></Centre>;
  }

  return (
    <Page sub>
      {back}
      <Title title={`Pay ${pounds(status.data.amountPence)} fee`} sub="Then your QR code" />
      <FeeForm billId={billId} onConfirmed={() => setConfirmed(true)} />
    </Page>
  );
}

function FeeForm({ billId, onConfirmed }: { billId: string; onConfirmed: () => void }) {
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
      <Form onConfirmed={onConfirmed} />
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
