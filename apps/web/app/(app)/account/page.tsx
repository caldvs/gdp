'use client';

/**
 * You: saved bank details, history, sign out. Accounts are optional for
 * guests; this is where the people who do have one keep things.
 */
import { useRouter } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { creditDate, useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { formatGBP } from '@gdp/core/lib/money';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { BackLink, Badge, Box, Button, Centre, Page, Row, RowLink, Section, Spinner, Title } from '@/components/ui';

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

  return (
    <Page sub>
      <BackLink href="/">Bills</BackLink>
      <Title title="Account" sub={me.data?.email ? `${name} · ${me.data.email}` : name} />
      <Box>
        <RowLink href="/payout-account?returnTo=%2Faccount" tall title="Bank details" sub={bankSub} />
        <RowLink href="/history" tall title="History" />
      </Box>
      <p className="small muted">Bank details stay on this device. We never see them.</p>
      {billing.data ? (
        <Section title="Platform fee">
          <Box>
            <Row
              title="Credits"
              sub={billing.data.creditsLeft === 0 ? `Free one ${creditDate(billing.data.nextCreditOn)}` : '1 free each month'}
              end={<Badge tone={billing.data.creditsLeft + billing.data.boughtCredits > 0 ? 'ok' : 'plain'}>{billing.data.creditsLeft + billing.data.boughtCredits} left</Badge>}
            />
            <RowLink href="/credits" title="Buy 10 credits" sub="Bills free for everyone" end={formatGBP(500)} />
            <Row
              title="Fees paid"
              sub={billing.data.refundedPence > 0 ? `${formatGBP(billing.data.refundedPence)} refunded` : undefined}
              end={formatGBP(billing.data.paidPence)}
            />
          </Box>
        </Section>
      ) : null}
      <Button tone="secondary" onClick={() => { void signOut({ everywhere: true }).then(() => router.replace('/sign-in')); }}>Sign out</Button>
    </Page>
  );
}
