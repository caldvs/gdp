'use client';

/**
 * M1 Account (#224): this month's free credit, bank details (this phone
 * only), the email bill emails go to, every bill, sign out.
 */
import { useRouter } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { creditDate, useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { BackLink, Box, Button, Centre, Page, Row, RowLink, Spinner, Title } from '@/components/ui';

export default function AccountPage() {
  const router = useRouter();
  const me = useMe();
  const payout = usePayoutAccount();
  const signOut = useSignOut();
  // Credits and fees, when the platform fee is on.
  const billing = useMyBilling({ enabled: !!STRIPE_PUBLISHABLE_KEY });

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
        <RowLink href="/payout-account?returnTo=%2Faccount" tall title="Bank details" sub={bank ? <>{bankSub}<br />On this phone only</> : 'Not saved'} />
        {me.data?.email ? <Row tall title="Email" sub={<>{me.data.email} · For your bill emails.</>} /> : null}
        <RowLink href="/history" tall title="Every bill" />
      </Box>
      <Button tone="secondary" onClick={() => { void signOut({ everywhere: true }).then(() => router.replace('/sign-in')); }}>Sign out</Button>
    </Page>
  );
}
