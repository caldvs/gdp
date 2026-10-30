'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { formatGBP } from '@gdp/core/lib/money';
import { Button, DisplayText, Notice, Receipt, Section, Spinner } from '@/components/ui';

export default function HomePage() {
  const me = useMe();
  const sessions = useMySessions(10);
  const payout = usePayoutAccount();
  const recent = sessions.data?.sessions ?? [];
  const needsPayout = !payout.isPending && !payout.data;
  const firstName = me.data?.displayName?.split(' ')[0] ?? '';
  const active = recent.filter((s) => isActive(s.status));
  const done = recent.filter((s) => !isActive(s.status));
  // Time-of-day greeting depends on the viewer's clock — compute after mount.
  const [greeting, setGreeting] = useState('Hello');
  useEffect(() => setGreeting(timeOfDayGreeting()), []);

  return (
    <div className="screen stack gap-lg">
      <div className="home-hero">
        <p className="gdp-body t-mute" style={{ fontSize: 14, marginBottom: 10 }}>
          {greeting}, {firstName || 'there'}
        </p>
        <DisplayText size="lg" as="p">Snap the bill.</DisplayText>
        <DisplayText size="lg" as="p">Split it.</DisplayText>
        <DisplayText size="lg" as="p" className="t-accent">Get paid.</DisplayText>
      </div>

      {needsPayout ? (
        <Link href="/payout-account" className="notice-link">
          <Notice neutral title="Add a payout account." detail="People can pay you direct once your bank details are in." />
        </Link>
      ) : null}

      <Button href="/capture" size="lg">＋  New bill</Button>

      {sessions.isPending ? (
        <div className="center" style={{ minHeight: 80 }}><Spinner /></div>
      ) : sessions.isError ? (
        <Notice title="Couldn't load your sessions." detail={sessions.error.message} />
      ) : recent.length > 0 ? (
        <>
          {active.length > 0 ? (
            <Section label="Active">
              {active.map((s) => (
                <Link key={s.sessionId} href={`/session/${s.sessionId}`} className="session-card">
                  <Receipt>
                    <div className="gdp-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="session-card__title">{titleFor(s)}</div>
                        <div className="session-card__sub">{formatDate(s.createdAt)}</div>
                      </div>
                    </div>
                  </Receipt>
                </Link>
              ))}
            </Section>
          ) : null}
          {done.length > 0 ? (
            <Section label="Done" gap="xs">
              <div>
                {done.map((s) => (
                  <Link key={s.sessionId} href={`/session/${s.sessionId}`} className="done-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="session-card__title" style={{ fontSize: 15 }}>{titleFor(s)}</div>
                      <div className="session-card__sub">{formatDate(s.createdAt)}</div>
                    </div>
                    {s.status === 'settled' && s.myOwedPence !== undefined ? (
                      <span className="done-row__amount">{formatGBP(s.myOwedPence)}</span>
                    ) : null}
                  </Link>
                ))}
              </div>
            </Section>
          ) : null}
        </>
      ) : (
        <p className="gdp-body t-mute t-center mt-lg">Nothing yet. Snap a bill to start.</p>
      )}
    </div>
  );
}

function isActive(status: SessionSummary['status']): boolean {
  return status === 'claiming' || status === 'paying' || status === 'setup';
}

function titleFor(s: SessionSummary): string {
  return s.venue?.name ?? (s.role === 'lead' ? 'You hosted' : 'You joined');
}

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Late';
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 22) return 'Evening';
  return 'Late';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === new Date().toDateString()) {
    return `Today, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
