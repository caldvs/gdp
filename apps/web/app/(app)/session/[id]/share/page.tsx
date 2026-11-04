'use client';

import { useState } from 'react';
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
import { SHARED_LINK_TTL_MS } from '@gdp/core/lib/qrPayload';
import { copyText } from '@/lib/clipboard';
import { JoinQr, useJoinUrl, useQrBuilt } from '@/components/JoinQr';
import { ActionBar, BackLink, Button, Centre, CopyIcon, Diners, Notice, Page, Section, ShareIcon, Spinner, TickIcon, Title, firstName } from '@/components/ui';

/**
 * The QR, the code, copy and share, and who's arrived. Anyone at the table
 * can open it, so a guest can pass the code on to people the host isn't
 * sitting near. A guest's QR carries the host's bank details from their
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
  const linkUrl = useJoinUrl(session.data?.joinCode, payout, SHARED_LINK_TTL_MS);
  const [copied, setCopied] = useState(false);
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
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const venue = bill.data?.venue?.name;

  const copy = async () => {
    if (!linkUrl) return;
    if (await copyText(linkUrl)) { setCopied(true); setTimeout(() => setCopied(false), 1400); }
  };
  const share = () => {
    if (!linkUrl) return;
    navigator.share({ title: 'Split the bill', text: `Tick what you had and pay ${isHost ? 'me' : hostFirst} back:`, url: linkUrl }).catch(() => {});
  };

  return (
    <>
      <Page sub>
        <BackLink href={`/session/${id}`}>{isHost ? 'Bill' : 'Your items'}</BackLink>
        <Title
          title="Share with the table"
          sub={`${venue ? `${venue}. ` : ''}${isHost ? 'Pass your phone round, or send the link.' : `Pass it on to anyone at ${hostFirst}’s table.`}`}
        />
        {isHost && !ownPayout.isPending && !ownPayout.data ? (
          <Notice title="No bank details yet.">Friends can join, but won’t see where to pay.</Notice>
        ) : null}
        {feePaid ? (
          <Notice tone="ok" title={feePaid.kind === 'hold' ? `${formatGBP(feePaid.amountPence)} hold · nothing taken now` : `${formatGBP(feePaid.amountPence)} platform fee paid`} />
        ) : fresh === 'credit' && billing.data ? (
          <Notice><b>1 credit spent</b> · next credit {creditDate(billing.data.nextCreditOn)}</Notice>
        ) : null}
        {!code ? (
          <Notice>{s.status === 'settled' ? 'This bill is closed.' : 'No code yet. Give it a moment.'}</Notice>
        ) : (
          <div className="qr-box">
            <JoinQr url={qrUrl} size={208} building={!!fresh && !built} />
            {built ? (
              <div className="code-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <div className="small muted">Or enter the code at Join a bill</div>
                <div className="code">{code}</div>
              </div>
            ) : (
              <div className="code-wait" role="status">Making your QR code…</div>
            )}
          </div>
        )}
        {code ? (
          <div className="btn-row">
            <Button tone="secondary" onClick={copy} disabled={!built} aria-label={copied ? 'Link copied' : 'Copy link'}>
              {copied ? <TickIcon /> : <CopyIcon />}{copied ? 'Copied' : 'Copy link'}
            </Button>
            {canShare ? <Button tone="secondary" onClick={share} disabled={!built} aria-label="Share link"><ShareIcon />Share</Button> : null}
          </div>
        ) : null}

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
