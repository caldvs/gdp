import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '../legal';

export const metadata: Metadata = { title: 'Help' };

/** #233: how claiming and paying work. Public, linked from Account and the landing page. */
export default function HelpPage() {
  return (
    <>
      <div className="title">
        <h1>Help</h1>
        <p>How claiming and paying work.</p>
      </div>

      <section>
        <h2>Splitting a bill</h2>
        <p>Whoever paid takes a photo of the bill and shows a QR code. Everyone scans it with their camera, taps what they had, and splits anything shared. No app, no account.</p>
      </section>

      <section>
        <h2>Paying back</h2>
        <p>Pay whoever paid by bank transfer, Monzo or Revolut, then tap <b>I’ve paid</b>. They mark it <b>Received</b> once it’s in their account. Transfer taking a while? Send them a screenshot.</p>
      </section>

      <section>
        <h2>Bank details</h2>
        <p>They stay on your phone and travel in the bill’s link. We never see them.</p>
      </section>

      <section>
        <h2>The platform fee</h2>
        <p>
          Your first bill each month is free. After that, sharing a bill holds £1 on your card. Your friends round their share up to the next pound to cover it, so you pay nothing. Nobody joins? Nothing’s taken. See <Link href="/refunds">Refunds</Link>.
        </p>
      </section>

      <section>
        <h2>Still stuck?</h2>
        <p>Email <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>.</p>
      </section>
    </>
  );
}
