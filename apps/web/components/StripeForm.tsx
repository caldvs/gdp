'use client';

/**
 * Stripe's embedded form (`ui_mode: form`), shared by the £1 hold
 * (/table-fee) and credit packs (/credits). Card details stay inside
 * Stripe's iframe.
 */
import { useState } from 'react';
import { loadStripe, type StripeCheckoutFormConfirmEvent } from '@stripe/stripe-js';
import { CheckoutForm, CheckoutFormProvider, useCheckoutForm } from '@stripe/react-stripe-js/checkout';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { Notice } from '@/components/ui';

// loadStripe fetches Stripe.js from js.stripe.com (never bundled), as PCI requires.
export const stripePromise = STRIPE_PUBLISHABLE_KEY ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null;

// Configured in Checkout Studio.
const appearance = {
  theme: 'stripe',
  labels: 'auto',
  inputs: 'spaced',
  variables: {
    borderRadius: '4px',
    colorBackground: '#ffffff',
    colorDanger: '#df1b41',
    colorPrimary: '#0a6fc2',
    colorSuccess: '#00c853',
    colorText: '#222222',
    fontFamily: 'default',
    fontSizeBase: '16px',
    spacingUnit: '4px',
  },
} as const;

/** A Checkout Session's client secret is `<session id>_secret_<…>`. */
export const sessionIdOf = (clientSecret: string) => clientSecret.split('_secret_')[0] ?? null;

/** The form for one Checkout Session; `onConfirmed` once Stripe has it (cards and wallets finish here). */
export function StripeForm({ clientSecret, onConfirmed, note }: { clientSecret: Promise<string>; onConfirmed: () => void; note: string }) {
  return (
    <CheckoutFormProvider stripe={stripePromise} options={{ clientSecret, appearance }}>
      <Form onConfirmed={onConfirmed} note={note} />
    </CheckoutFormProvider>
  );
}

function Form({ onConfirmed, note }: { onConfirmed: () => void; note: string }) {
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
      <p className="muted small" style={{ textAlign: 'center' }}>{note}</p>
    </>
  );
}
