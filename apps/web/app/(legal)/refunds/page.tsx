import type { Metadata } from 'next';
import { LEGAL } from '../legal';

export const metadata: Metadata = { title: 'Refunds' };

export default function RefundsPage() {
  return (
    <>
      <div className="title">
        <h1>Refunds</h1>
        <p>Last updated {LEGAL.updated}</p>
      </div>

      <section>
        <p>
          Sharing a bill without a free credit puts a £1 hold on your card. When you mark the bill as settled, we release it and
          charge your card your guests’ round-ups (their shares rounded up to the next pound, which they pay to you). The service is
          supplied as soon as you share, so the usual 14-day cancellation period doesn’t apply.
        </p>
      </section>

      <section>
        <h2>When we take nothing</h2>
        <p>If nobody joins the bill, you delete it, or you never mark it as settled, we release the hold: nothing is charged.</p>
        <p>A free credit spent on a bill nobody joined is given back.</p>
      </section>

      <section>
        <h2>When to ask us</h2>
        <ul>
          <li>You were charged but couldn’t share the bill.</li>
          <li>You were charged twice for the same bill.</li>
          <li>Something else went wrong on our side.</li>
        </ul>
        <p>
          Email <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a> within 30 days with the date and the restaurant.
          Refunds go back to the card you paid with and usually arrive in 5 to 10 working days.
        </p>
      </section>

      <section>
        <h2>Money between diners</h2>
        <p>
          Guests pay the lead directly by bank transfer, so we can’t refund or chase those payments. Sort them out with
          each other.
        </p>
      </section>

      <section>
        <p className="muted">This doesn’t affect your statutory rights.</p>
      </section>
    </>
  );
}
