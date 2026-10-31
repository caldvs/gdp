'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { ApiError, type components } from '@gdp/core/api';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { projectOwedPence } from '@gdp/core/lib/owed';
import { useInitiatePayment } from '@gdp/core/api/hooks/useInitiatePayment';
import { useConfirmPayment, useMarkPaymentPaid } from '@gdp/core/api/hooks/usePaymentActions';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { formatGBP } from '@gdp/core/lib/money';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { clearSessionPayout } from '@gdp/core/lib/sessionPayout';
import { chaseDiner, shouldShowChase } from '@/lib/chase';
import { DinerRow } from '@/components/DinerRow';
import { PaymentDetailsReceipt } from '@/components/PaymentDetailsReceipt';
import { QuickPayLinks } from '@/components/QuickPayLinks';
import { BodyText, Button, CenterSpinner, DisplayText, HeroAmount, Mini, Notice, Rule, SessionChip, Spinner } from '@/components/ui';

type Participant = components['schemas']['Participant'];
type Session = components['schemas']['Session'];
type Instructions = components['schemas']['PaymentInstructions'];
type ManualInstructions = Extract<Instructions, { type: 'manual_transfer' }>;

export default function PayPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId);
  const initiate = useInitiatePayment(id ?? '');
  const markPaid = useMarkPaymentPaid(id);
  const confirm = useConfirmPayment(id);
  const [instructions, setInstructions] = useState<ManualInstructions | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  if (session.isPending || me.isPending) return <CenterSpinner />;
  if (session.isError) return <div className="center"><Notice title="Couldn't load the session." detail={session.error.message} /></div>;
  const s = session.data;
  if (!me.data) return null;
  const meId = me.data.userId;
  const isCreator = meId === s.creatorUserId;
  const myParticipant = s.participants.find((p) => p.userId === meId);
  const allSettled = s.participants.every((p) => p.payment.status === 'self_paid' || p.payment.status === 'succeeded');

  const onPay = () => {
    initiate.mutate(undefined, {
      onSuccess: (res) => {
        if (res.instructions.type === 'manual_transfer') setInstructions(res.instructions);
        else if (res.instructions.type === 'redirect') window.open(res.instructions.url, '_blank', 'noopener');
      },
    });
  };

  return (
    <div className="screen stack gap-base">
      <div className="gdp-row">
        <DisplayText size="md" as="h2">{isCreator ? 'Collecting payments' : 'Pay your share'}</DisplayText>
        <SessionChip status={s.status} />
      </div>

      {isCreator ? (
        <Notice
          neutral
          title="You collected the bill."
          detail="Other diners pay you direct. When you see money arrive in your bank, tap 'mark received' on each guest below."
        />
      ) : null}

      {!isCreator && myParticipant ? (
        <GuestPayBlock
          participant={myParticipant}
          projectedOwedPence={bill.data ? projectOwedPence(s, bill.data, meId) : undefined}
          creator={creatorName(s)}
          sessionId={id ?? ''}
          instructions={instructions}
          onPay={onPay}
          payPending={initiate.isPending}
          payError={initiate.error?.message}
          payErrorCode={initiate.error instanceof ApiError ? initiate.error.code : undefined}
          markPaid={markPaid}
        />
      ) : null}

      {isCreator ? (
        <section className="stack gap-xs">
          <Mini>diners</Mini>
          <div className="diners">
            {s.participants.map((p) => {
              const isLead = p.userId === s.creatorUserId;
              const canConfirm = !isLead && p.payment.status === 'pending';
              const canChase = !isLead && shouldShowChase(p.payment);
              return (
                <DinerRow
                  key={p.userId}
                  p={p}
                  isMe={p.userId === meId}
                  isLead={isLead}
                  variant="paying"
                  fallbackOwedPence={bill.data ? projectOwedPence(s, bill.data, p.userId) : undefined}
                  onMarkReceived={canConfirm ? () => { if (p.payment.status === 'pending') confirm.mutate(p.payment.paymentId); } : undefined}
                  onChase={canChase ? async () => {
                    const r = await chaseDiner(p, me.data?.displayName ?? 'me');
                    if (r === 'copied') { setToast('Copied — paste it into your messages.'); setTimeout(() => setToast(null), 2500); }
                  } : undefined}
                />
              );
            })}
          </div>
          {confirm.isError ? <Notice title="Couldn't confirm." detail={confirm.error.message} /> : null}
          {toast ? <Notice neutral detail={toast} /> : null}
        </section>
      ) : null}

      {isCreator && allSettled ? <BodyText className="t-center">All payments accounted for. Settled.</BodyText> : null}

      <Link href={`/session/${id}`} replace className="back-link"><ChevronLeft size={14} /> back to session</Link>
    </div>
  );
}

function GuestPayBlock({ participant, projectedOwedPence, creator, sessionId, instructions, onPay, payPending, payError, payErrorCode, markPaid }: {
  participant: Participant; projectedOwedPence?: number; creator: string; sessionId: string; instructions: ManualInstructions | null;
  onPay: () => void; payPending: boolean; payError?: string; payErrorCode?: string;
  markPaid: { mutate: (paymentId: string) => void; isPending: boolean };
}) {
  const sessionPayout = useSessionPayout(sessionId);
  const isPending = participant.payment.status === 'pending';
  const isUnpaid = participant.payment.status === 'unpaid';
  const claimedAt = participant.payment.status === 'pending' ? participant.payment.payerClaimedPaidAt ?? null : null;

  // Open the payment as soon as the guest lands here, so the reference
  // is ready by the time they've opened their banking app.
  const initiatedRef = useRef(false);
  useEffect(() => {
    if (initiatedRef.current || !isUnpaid || payPending) return;
    initiatedRef.current = true;
    onPay();
  }, [isUnpaid, payPending, onPay]);

  // Once the host has confirmed the money arrived, the guest no longer
  // needs the host's bank details on this device.
  const paidUp = participant.payment.status === 'succeeded';
  useEffect(() => {
    if (paidUp) clearSessionPayout(sessionId);
  }, [paidUp, sessionId]);

  // ADR-0002: the details the lead shared in the QR are the source of
  // truth; the server's copy (if any) is a legacy fallback.
  const qr = sessionPayout.data;
  const bd = qr ?? instructions?.bankDetails;
  const accountHolderName = bd?.accountHolderName;
  const sortCode = bd?.sortCode;
  const accountNumber = bd?.accountNumber;
  // Before the server fixes owedPence, show the same estimate as the session screen.
  const amountPence = instructions?.amountPence ?? participant.owedPence ?? (projectedOwedPence || undefined);
  // The server derives the reference from the session id, so it can be
  // shown again after a reload (re-initiating a pending payment is rejected).
  const reference = instructions?.reference ?? (isPending ? `gdp-${sessionId.slice(0, 8)}` : undefined);
  const firstName = creator.split(' ')[0] ?? 'their';

  return (
    <>
      <HeroAmount
        caption={`Send to ${creator}`}
        amount={amountPence !== undefined ? formatGBP(amountPence) : '—'}
        note={`Goes straight to ${firstName}'s bank. We never see your money.`}
      />
      {participant.payment.status === 'unpaid' || participant.payment.status === 'pending' ? (
        <QuickPayLinks monzoHandle={qr?.monzoHandle} revolutTag={qr?.revolutTag} amountPence={amountPence} note={reference} />
      ) : null}
      {accountHolderName && sortCode && accountNumber ? (
        <PaymentDetailsReceipt bankDetails={{ accountHolderName, sortCode, accountNumber }} reference={reference} amountPence={amountPence} />
      ) : payPending ? (
        <div className="center" style={{ minHeight: 80 }}><Spinner /></div>
      ) : (
        <Notice
          neutral
          title={`No bank details from ${firstName} yet.`}
          detail={`They travel inside the QR code. Ask ${firstName} to show it again and scan it with this phone.`}
        />
      )}
      {payError ? (
        <Notice
          title="Payment didn't start."
          detail={payErrorCode === 'PAYOUT_ACCOUNT_REQUIRED' && accountHolderName
            ? `You can still pay ${firstName} using the details above — just let them know once it's sent.`
            : payError}
        />
      ) : null}
      {isPending && participant.payment.status === 'pending' ? (
        <div className="stack gap-sm">
          <Rule style={{ margin: '4px 0' }} />
          {claimedAt ? (
            <p className="gdp-body t-center t-mute">Marked paid · {hhmm(claimedAt)} · awaiting confirmation</p>
          ) : (
            <Button disabled={markPaid.isPending} onClick={() => participant.payment.status === 'pending' && markPaid.mutate(participant.payment.paymentId)}>
              {markPaid.isPending ? <Spinner /> : "I've sent it"}
            </Button>
          )}
        </div>
      ) : null}
      {participant.payment.status === 'succeeded' ? <p className="gdp-body t-center t-accent" style={{ fontWeight: 600 }}>Paid · all squared up</p> : null}
      {participant.payment.status === 'self_paid' ? <Mini className="t-center">you collected the bill — nothing to pay</Mini> : null}
      {participant.payment.status === 'failed' ? <Button disabled={payPending} onClick={onPay}>Try again →</Button> : null}
    </>
  );
}

function creatorName(s: Session): string {
  return s.participants.find((p) => p.userId === s.creatorUserId)?.displayName ?? 'the lead';
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
