'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { SHARED_LINK_TTL_MS } from '@gdp/core/lib/qrPayload';
import { copyText } from '@/lib/clipboard';
import { JoinQr, useJoinUrl } from '@/components/JoinQr';
import { Back, Backdrop, Btn, Centre, CopyIcon, Fab, Notice, Screen, ShareIcon, Sheet, Spin, Tick, TopBar } from '@/components/glass';

/** "Scan to join": QR, code, copy and share. Nothing else. */
export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const bill = useBill(session.data?.billId);
  const payout = usePayoutAccount();
  const qrUrl = useJoinUrl(session.data?.joinCode, payout.data ?? null);
  const linkUrl = useJoinUrl(session.data?.joinCode, payout.data ?? null, SHARED_LINK_TTL_MS);
  const [copied, setCopied] = useState(false);

  if (session.isPending) return <Centre><Spin /></Centre>;
  if (session.isError) return <Centre><Notice error title="Couldn't load the bill.">{session.error.message}</Notice></Centre>;
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
    <Screen>
      <Backdrop billId={session.data.billId} tone="soft" />
      <TopBar left={<Fab href={`/session/${id}`} label="Back" icon={<Back />} replace />} />
      <Sheet
        title="Scan to join"
        sub={bill.data?.venue?.name}
        foot={<Btn href={`/session/${id}`} replace>Done</Btn>}
      >
        {!payout.isPending && !payout.data ? (
          <Notice title="No bank details yet.">Friends can join, but won&apos;t see where to pay.</Notice>
        ) : null}
        {!code ? (
          <Notice>No code yet. Give it a moment.</Notice>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '4px 0' }}>
            <div className="g-qr"><JoinQr url={qrUrl} size={208} /></div>
            <div className="g-code">{code}</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" className="g-fab g-fab--icon" style={{ width: 56, height: 56, borderRadius: 28, background: copied ? 'var(--g-accent)' : undefined, color: copied ? 'var(--g-on-accent)' : undefined }} aria-label={copied ? 'Link copied' : 'Copy link'} onClick={copy}>
                {copied ? <Tick size={22} /> : <CopyIcon />}
              </button>
              {canShare ? (
                <button type="button" className="g-fab g-fab--icon" style={{ width: 56, height: 56, borderRadius: 28 }} aria-label="Share link" onClick={share}><ShareIcon /></button>
              ) : null}
            </div>
          </div>
        )}
      </Sheet>
    </Screen>
  );
}
