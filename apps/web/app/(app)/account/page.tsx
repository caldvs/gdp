'use client';

/**
 * You: saved bank details, history, sign out. Accounts are optional for
 * guests; this is where the people who do have one keep things.
 */
import { useRouter } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { Avatar, Back, Backdrop, Btn, Centre, Chevron, Fab, List, Row, RowBody, Screen, Sheet, Spin, TopBar } from '@/components/glass';

export default function AccountPage() {
  const router = useRouter();
  const me = useMe();
  const payout = usePayoutAccount();
  const signOut = useSignOut();

  if (me.isPending) return <Centre><Spin /></Centre>;
  const name = me.data?.displayName ?? 'You';
  const bank = payout.data;
  const bankSub = bank
    ? [`${bank.sortCode.replace(/(\d{2})(?=\d)/g, '$1-')} · ····${bank.accountNumber.slice(-4)}`, bank.monzoHandle && 'Monzo', bank.revolutTag && 'Revolut'].filter(Boolean).join(' · ')
    : 'Not saved';

  return (
    <Screen>
      <Backdrop tone="deep" />
      <TopBar left={<Fab href="/" label="Back" icon={<Back />} replace />} />
      <Sheet
        head={
          <header className="g-sheet__head" style={{ alignItems: 'center' }}>
            <div style={{ display: "flex", justifyContent: "center" }}><Avatar name={name} seed={me.data?.userId} size={64} /></div>
            <h1 className="g-sheet__title">{name}</h1>
            {me.data?.email ? <p className="g-sheet__sub">{me.data.email}</p> : null}
          </header>
        }
        foot={<Btn tone="ghost" onClick={() => { void signOut().then(() => router.replace('/sign-in')); }}>Sign out</Btn>}
      >
        <List>
          <Row href="/payout-account?returnTo=%2Faccount">
            <RowBody name="Bank details" sub={bankSub} />
            <Chevron />
          </Row>
          <Row href="/history">
            <RowBody name="History" />
            <Chevron />
          </Row>
        </List>
        <p className="g-foot-note">Bank details stay on this phone. We never see them.</p>
      </Sheet>
    </Screen>
  );
}
