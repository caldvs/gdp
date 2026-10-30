'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { copyText } from '@/lib/clipboard';
import { JoinQr, useJoinUrl } from '@/components/JoinQr';
import { BodyText, Button, CenterSpinner, DisplayText, Mini, Notice } from '@/components/ui';

export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const payout = usePayoutAccount();
  const joinUrl = useJoinUrl(session.data?.joinCode, payout.data ?? null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  if (session.isPending) return <CenterSpinner />;
  if (session.isError) return <div className="center"><Notice title="Couldn't load the session." detail={session.error.message} /></div>;
  const code = session.data.joinCode;

  const copy = async (what: 'code' | 'link', text: string | null | undefined) => {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    }
  };
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="screen stack gap-lg" style={{ alignItems: 'center' }}>
      <div className="stack gap-sm t-center">
        <DisplayText size="md" as="h2">Pass the table a code.</DisplayText>
        <BodyText>Have diners point their phone camera at this.</BodyText>
      </div>

      {!payout.isPending && !payout.data ? (
        <Link href={`/payout-account?returnTo=${encodeURIComponent(`/session/${id}/share`)}`} className="notice-link">
          <Notice title="No bank details yet." detail="Diners can join, but they won't see where to pay. Tap to add yours." />
        </Link>
      ) : null}

      {!code ? (
        <Notice title="No join code yet." detail="Give it a moment, then try again." />
      ) : (
        <>
          <JoinQr url={joinUrl} size={240} />
          <div className="stack gap-xs" style={{ alignItems: 'center' }}>
            <Mini>or share this code</Mini>
            <span className="join-code">{code}</span>
          </div>
          <div className="two-col">
            <Button variant="ghost" onClick={() => copy('code', code)}>{copied === 'code' ? 'Copied ✓' : 'Copy code'}</Button>
            <Button variant="ghost" onClick={() => copy('link', joinUrl)}>{copied === 'link' ? 'Copied ✓' : 'Copy link'}</Button>
          </div>
          {canNativeShare && joinUrl ? (
            <Button variant="ghost" onClick={() => navigator.share({ title: 'Join the bill', text: 'Pick what you had and pay me back:', url: joinUrl }).catch(() => {})}>
              Share…
            </Button>
          ) : null}
          {joinUrl ? <p className="deep-link">{joinUrl.replace(/^https?:\/\//, '').replace(/#.*$/, '')}</p> : null}
        </>
      )}

      <Button href={`/session/${id}`} replace>Done →</Button>
    </div>
  );
}
