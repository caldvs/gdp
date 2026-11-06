'use client';

/**
 * #228: the round-ups charge at settle, when the lead's bank wanted them to
 * confirm it. Linked from the email and the settled bill. The saved card
 * first (Stripe.js runs 3D Secure); another card in Stripe's Payment Element
 * if that one won't do. Card details stay inside Stripe's iframe.
 */
import { use, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { cardLabel, useFeeCharge } from '@gdp/core/api/hooks/useTableFee';
import { formatGBP } from '@gdp/core/lib/money';
import { stripePromise } from '@/components/StripeForm';
import { BackLink, Box, Button, Centre, Notice, Page, Row, Spinner, Title } from '@/components/ui';

export default function FeeChargePage({ params }: { params: Promise<{ billId: string }> }) {
  const { billId } = use(params);
  const [confirmed, setConfirmed] = useState(false);
  const charge = useFeeCharge(billId, { poll: confirmed });
  const [other, setOther] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = <BackLink href="/">Bills</BackLink>;

  if (charge.isPending) return <Centre><Spinner /></Centre>;
  if (charge.isError) {
    return (
      <Page sub>
        {back}
        <Notice tone="error" title="Couldn’t load the charge.">{charge.error.message}</Notice>
      </Page>
    );
  }
  const c = charge.data;
  if (c.status !== 'needs_confirming') {
    return (
      <Page sub>
        {back}
        <Title title={c.status === 'charged' ? `${formatGBP(c.amountPence)} charged` : 'Nothing to pay'} sub="Platform fee · your hold is released" />
      </Page>
    );
  }
  if (confirmed) return <Centre><Spinner /></Centre>;

  const paySaved = async () => {
    if (!c.clientSecret || !c.paymentMethodId) return;
    setBusy(true);
    setError(null);
    const stripe = await stripePromise;
    const out = await stripe?.confirmCardPayment(c.clientSecret, { payment_method: c.paymentMethodId });
    setBusy(false);
    if (!out || out.error) setError(out?.error?.message ?? 'Payments aren’t set up.');
    else setConfirmed(true);
  };

  return (
    <Page sub>
      {back}
      <Title title="Confirm the platform fee" sub="Your guests’ round-ups. Your hold is released." />
      <Box><Row title="Platform fee" end={formatGBP(c.amountPence)} /></Box>
      {error ? <Notice tone="error" title="It didn’t go through.">{error}</Notice> : null}
      {!stripePromise || !c.clientSecret ? (
        <Notice tone="error" title="Payments aren’t set up." />
      ) : c.paymentMethodId && !other ? (
        <>
          <Button busy={busy} onClick={() => void paySaved()}>
            {`Pay ${formatGBP(c.amountPence)} with ${c.card ? cardLabel(c.card) : 'your card'}`}
          </Button>
          <Button tone="secondary" onClick={() => setOther(true)}>Use another card</Button>
        </>
      ) : (
        <Elements stripe={stripePromise} options={{ clientSecret: c.clientSecret }}>
          <OtherCard amountPence={c.amountPence} billId={billId} onConfirmed={() => setConfirmed(true)} onError={setError} />
        </Elements>
      )}
    </Page>
  );
}

function OtherCard({ amountPence, billId, onConfirmed, onError }: { amountPence: number; billId: string; onConfirmed: () => void; onError: (m: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    const out = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: `${window.location.origin}/fee-charge/${billId}` },
    });
    setBusy(false);
    if (out.error) onError(out.error.message ?? 'Your card didn’t go through.');
    else onConfirmed();
  };
  return (
    <>
      <PaymentElement />
      <Button busy={busy} onClick={() => void pay()}>{`Pay ${formatGBP(amountPence)}`}</Button>
    </>
  );
}
