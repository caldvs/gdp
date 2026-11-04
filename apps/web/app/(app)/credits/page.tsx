'use client';

/**
 * Buy 10 credits for £5 (#169). Each shares a bill free for everyone. They
 * never expire and can't be refunded (they're supplied straight away).
 * `?returnTo=` comes back to where the lead was, e.g. the bill they're sharing.
 */
import { useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCreditPackStatus, useStartCreditPack } from '@gdp/core/api/hooks/useTableFee';
import { formatGBP } from '@gdp/core/lib/money';
import { ActionBar, BackLink, Box, Button, Notice, Page, Row, Spinner, Title } from '@/components/ui';
import { StripeForm, sessionIdOf, stripePromise } from '@/components/StripeForm';

/** Only a page on this site. */
const safeReturn = (to: string | null) => (to && to.startsWith('/') && !to.startsWith('//') ? to : null);

export default function CreditsPage() {
  const params = useSearchParams();
  const returnTo = safeReturn(params.get('returnTo'));
  const back = returnTo ?? '/account';
  // Back from a redirect-based payment method: Stripe adds ?session_id=…
  const [checkoutSessionId, setCheckoutSessionId] = useState<string | null>(params.get('session_id'));
  const status = useCreditPackStatus(checkoutSessionId, { poll: true });
  const queryClient = useQueryClient();

  if (!stripePromise) {
    return (
      <Page sub>
        <BackLink href={back}>Back</BackLink>
        <Notice tone="error" title="Payments aren’t set up.">Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.</Notice>
      </Page>
    );
  }

  if (checkoutSessionId) {
    const done = status.data?.recorded;
    if (done) void queryClient.invalidateQueries({ queryKey: ['billing'] });
    return (
      <>
        <Page>
          <div className="box pay-wait" role="status" aria-live="polite">
            {done ? null : <Spinner />}
            <h1 className="pay-wait__title">{done ? '10 credits added' : 'Confirming payment'}</h1>
            <p className="muted">{done ? `${status.data?.boughtCredits ?? 10} credits left` : 'Don’t close this page.'}</p>
          </div>
        </Page>
        {done ? <ActionBar><Button grow href={back} replace>{returnTo ? 'Back to the bill' : 'Done'}</Button></ActionBar> : null}
      </>
    );
  }

  return (
    <Page sub>
      <BackLink href={back}>Back</BackLink>
      <Title title="10 credits for £5" sub="Each one shares a bill free for everyone. They never expire." />
      <Box><Row title="10 credits" end={formatGBP(500)} /></Box>
      <PackForm returnTo={returnTo} onConfirmed={setCheckoutSessionId} />
    </Page>
  );
}

function PackForm({ returnTo, onConfirmed }: { returnTo: string | null; onConfirmed: (id: string | null) => void }) {
  const start = useStartCreditPack();
  // One Checkout Session per visit, even when React runs effects twice in dev.
  const clientSecret = useRef<Promise<string> | null>(null);
  if (clientSecret.current === null) {
    clientSecret.current = start.mutateAsync(returnTo ? { returnTo } : {}).then((r) => r.client_secret);
  }
  if (start.isError) {
    return <Notice tone="error" title="Couldn’t start the payment.">{start.error.message}</Notice>;
  }
  return (
    <StripeForm
      clientSecret={clientSecret.current}
      onConfirmed={() => { void clientSecret.current?.then((secret) => onConfirmed(sessionIdOf(secret))); }}
      note="Yours straight away, so they can’t be refunded"
    />
  );
}
