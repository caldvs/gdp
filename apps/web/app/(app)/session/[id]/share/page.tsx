'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { SHARED_LINK_TTL_MS } from '@gdp/core/lib/qrPayload';
import { copyText } from '@/lib/clipboard';
import { JoinQr, useJoinUrl } from '@/components/JoinQr';
import { ActionBar, BackLink, Button, Centre, CopyIcon, Notice, Page, ShareIcon, Spinner, TickIcon, Title } from '@/components/ui';

/** Share: QR, code, copy and share. Nothing else. */
export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const bill = useBill(session.data?.billId);
  const payout = usePayoutAccount();
  const qrUrl = useJoinUrl(session.data?.joinCode, payout.data ?? null);
  const linkUrl = useJoinUrl(session.data?.joinCode, payout.data ?? null, SHARED_LINK_TTL_MS);
  const [copied, setCopied] = useState(false);

  if (session.isPending) return <Centre><Spinner /></Centre>;
  if (session.isError) return <Centre><Notice tone="error" title="Couldn’t load the bill.">{session.error.message}</Notice></Centre>;
  const code = session.data.joinCode;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    if (!linkUrl) return;
    if (await copyText(linkUrl)) { setCopied(true); setTimeout(() => setCopied(false), 1400); }
  };
  const share = () => {
    if (!linkUrl) return;
    navigator.share({ title: 'Split the bill', text: 'Tick what you had and pay me back:', url: linkUrl }).catch(() => {});
  };

  return (
    <>
      <Page sub>
        <BackLink href={`/session/${id}`}>Bill</BackLink>
        <Title title="Share with the table" sub={bill.data?.venue?.name ? `${bill.data.venue.name}. Friends scan the code to pick what they had.` : 'Friends scan the code to pick what they had.'} />
        {!payout.isPending && !payout.data ? (
          <Notice title="No bank details yet.">Friends can join, but won’t see where to pay.</Notice>
        ) : null}
        {!code ? (
          <Notice>No code yet. Give it a moment.</Notice>
        ) : (
          <div className="qr-box">
            <JoinQr url={qrUrl} size={208} />
            <div className="small muted">Or enter the code at Join a bill</div>
            <div className="code">{code}</div>
          </div>
        )}
        {code ? (
          <div className="btn-row">
            <Button tone="secondary" onClick={copy} aria-label={copied ? 'Link copied' : 'Copy link'}>
              {copied ? <TickIcon /> : <CopyIcon />}{copied ? 'Copied' : 'Copy link'}
            </Button>
            {canShare ? <Button tone="secondary" onClick={share} aria-label="Share link"><ShareIcon />Share</Button> : null}
          </div>
        ) : null}
      </Page>
      <ActionBar>
        <Button grow href={`/session/${id}`} replace>Go to the bill</Button>
      </ActionBar>
    </>
  );
}
