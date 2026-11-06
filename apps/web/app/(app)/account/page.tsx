'use client';

/**
 * M1 Account (#224): this month's free credit, the card saved for the
 * platform fee (#228), bank details (this phone only), the email bill emails
 * go to, every bill, sign out.
 */
import { useRouter } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { cardLabel, creditDate, useMyBilling, useRemoveCard } from '@gdp/core/api/hooks/useTableFee';
import { BackLink, Box, Button, Centre, Notice, Page, Row, RowButton, RowLink, Spinner, Title } from '@/components/ui';

export default function AccountPage() {
  const router = useRouter();
  const me = useMe();
  const payout = usePayoutAccount();
  const signOut = useSignOut();
  // Credits, fees and the saved card; null when the platform fee is off.
  const billing = useMyBilling();
  const removeCard = useRemoveCard();

  if (me.isPending) return <Centre><Spinner /></Centre>;
  const name = me.data?.displayName ?? 'You';
  const bank = payout.data;
  // #204: the dots are read out as dots; say "ending 1234" instead.
  const last4 = bank?.accountNumber.slice(-4);
  const bankSub = bank ? (
    <>
      {bank.sortCode.replace(/(\d{2})(?=\d)/g, '$1-')} · <span aria-hidden>····{last4}</span><span className="vh">account ending {last4}</span>
      {[bank.monzoHandle && 'Monzo', bank.revolutTag && 'Revolut'].filter(Boolean).map((h) => ` · ${h}`).join('')}
    </>
  ) : 'Not saved';

  const credit = billing.data;
  return (
    <Page sub>
      <BackLink href="/">Bills</BackLink>
      <Title title="Account" sub={name} />
      {/* M1 (#224): this month's free credit; no bought credits (#227). */}
      {credit ? (
        <div className="credit-card" data-testid="free-credit">
          <div className="credit-card__top"><b>Free credit</b><b>{credit.creditsLeft > 0 ? '1 this month' : 'Used this month'}</b></div>
          <span className="muted">Next one {creditDate(credit.nextCreditOn)}</span>
        </div>
      ) : null}
      <Box list>
        {credit?.card ? (
          <RowButton
            tall
            title="Card"
            sub={<>{cardLabel(credit.card)} · For the platform fee</>}
            end={removeCard.isPending ? 'Removing…' : 'Remove'}
            label={`Remove ${cardLabel(credit.card)}`}
            disabled={removeCard.isPending}
            onClick={() => removeCard.mutate()}
          />
        ) : null}
        <RowLink href="/payout-account?returnTo=%2Faccount" tall title="Bank details" sub={bank ? <>{bankSub}<br />On this phone only</> : 'Not saved'} />
        {me.data?.email ? <Row tall title="Email" sub={<>{me.data.email} · For your bill emails.</>} /> : null}
        <RowLink href="/history" tall title="Every bill" />
        <RowLink href="/help" tall title="Help" sub="How claiming and paying work" />
      </Box>
      {removeCard.error ? <Notice tone="error" title="Couldn’t remove the card.">{removeCard.error.message}</Notice> : null}
      <Button tone="secondary" onClick={() => { void signOut({ everywhere: true }).then(() => router.replace('/sign-in')); }}>Sign out</Button>
    </Page>
  );
}
