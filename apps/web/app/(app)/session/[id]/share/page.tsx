'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { creditDate, useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { formatGBP } from '@gdp/core/lib/money';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { usePayoutVerdict, usePublishPayoutCheck } from '@gdp/core/lib/usePayoutCheck';
import { JoinQr, useJoinUrl, useQrBuilt } from '@/components/JoinQr';
import { ActionBar, BackLink, Button, Centre, Diners, Notice, Page, Section, Spinner, Title, firstName } from '@/components/ui';

/**
 * The QR and who's arrived. Scanning the QR is the only way to join (#182):
 * no code to type, no link to copy. Anyone at the table can open it, so a
 * guest can show it to people the host isn't sitting near. A guest's QR carries the host's bank details from their
 * own join link.
 */
export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);
  const isHost = !!session.data && session.data.creatorUserId === me.data?.userId;
  const ownPayout = usePayoutAccount();
  const fromLink = useSessionPayout(id);
  // #151: the lead's device tells the session what its link's details hash
  // to; a guest passes on only details that match it.
  usePublishPayoutCheck(session.data, ownPayout.data ?? null, isHost);
  const verdict = usePayoutVerdict(id, fromLink.data, session.data?.payoutCheck);
  const payout = isHost ? ownPayout.data ?? null : verdict === 'mismatch' ? null : fromLink.data;
  const qrUrl = useJoinUrl(session.data?.joinCode, payout);
  // Just shared (#129): `?new=fee|credit|1`. The QR fills in, and the
  // buttons wait for it.
  const fresh = useSearchParams().get('new');
  const built = useQrBuilt(!!fresh, qrUrl);
  const billing = useMyBilling({ enabled: !!STRIPE_PUBLISHABLE_KEY && (fresh === 'fee' || fresh === 'credit') });
  const feePaid = fresh === 'fee' ? billing.data?.fees.find((f) => f.sessionId === id) : undefined;

  if (session.isPending || me.isPending) return <Centre><Spinner /></Centre>;
  if (session.isError) return <Centre><Notice tone="error" title="Couldn’t load the bill.">{session.error.message}</Notice></Centre>;
  const s = session.data;
  const code = s.joinCode;
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const venue = bill.data?.venue?.name;

  return (
    <>
      <Page sub>
        <BackLink href={`/session/${id}`}>{isHost ? 'Bill' : 'Your items'}</BackLink>
        <Title
          title="Share with the table"
          sub={`${venue ? `${venue}. ` : ''}${isHost ? 'Pass your phone round. Friends scan to join.' : `Show it to anyone at ${hostFirst}’s table.`}`}
        />
        {isHost && !ownPayout.isPending && !ownPayout.data ? (
          <Notice title="No bank details yet.">Friends can join, but won’t see where to pay.</Notice>
        ) : null}
        {feePaid ? (
          <Notice tone="ok" title={feePaid.kind === 'hold' ? `${formatGBP(feePaid.amountPence)} hold · nothing taken now` : `${formatGBP(feePaid.amountPence)} platform fee paid`} />
        ) : fresh === 'credit' && billing.data ? (
          <Notice><b>1 credit spent</b> · {billing.data.boughtCredits > 0 ? `${billing.data.boughtCredits + billing.data.creditsLeft} left` : `next credit ${creditDate(billing.data.nextCreditOn)}`}</Notice>
        ) : null}
        {!code ? (
          <Notice>{s.status === 'settled' ? 'This bill is closed.' : 'No code yet. Give it a moment.'}</Notice>
        ) : (
          <div className="qr-box">
            <JoinQr url={qrUrl} size={208} building={!!fresh && !built} />
            {built ? (
              <div className="code-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div className="qr-hint">Point a phone camera here</div>
                <div className="small muted">Scanning is the only way in.</div>
              </div>
            ) : (
              <div className="code-wait" role="status">Making your QR code…</div>
            )}
          </div>
        )}

        <Section title={`At the table · ${s.participants.length}`}>
          <Diners people={s.participants} hostId={s.creatorUserId} meId={me.data?.userId} />
          {s.participants.length <= 1 ? <p className="small muted">People appear here as they join.</p> : null}
        </Section>
      </Page>
      <ActionBar>
        <Button grow href={`/session/${id}`} replace disabled={!built}>{isHost ? 'Go to the bill' : 'Back to your items'}</Button>
      </ActionBar>
    </>
  );
}
