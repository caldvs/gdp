'use client';

/**
 * You: saved bank details, history, sign out. Accounts are optional for
 * guests; this is where the people who do have one keep things.
 */
import { useRouter } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { BackLink, Box, Button, Centre, Page, RowLink, Spinner, Title } from '@/components/ui';

export default function AccountPage() {
  const router = useRouter();
  const me = useMe();
  const payout = usePayoutAccount();
  const signOut = useSignOut();

  if (me.isPending) return <Centre><Spinner /></Centre>;
  const name = me.data?.displayName ?? 'You';
  const bank = payout.data;
  const bankSub = bank
    ? [`${bank.sortCode.replace(/(\d{2})(?=\d)/g, '$1-')} · ····${bank.accountNumber.slice(-4)}`, bank.monzoHandle && 'Monzo', bank.revolutTag && 'Revolut'].filter(Boolean).join(' · ')
    : 'Not saved';

  return (
    <Page sub>
      <BackLink href="/">Bills</BackLink>
      <Title title="Account" sub={me.data?.email ? `${name} · ${me.data.email}` : name} />
      <Box>
        <RowLink href="/payout-account?returnTo=%2Faccount" tall title="Bank details" sub={bankSub} />
        <RowLink href="/history" tall title="History" />
      </Box>
      <p className="small muted">Bank details stay on this device. We never see them.</p>
      <Button tone="secondary" onClick={() => { void signOut().then(() => router.replace('/sign-in')); }}>Sign out</Button>
    </Page>
  );
}
