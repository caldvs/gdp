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
          Sharing a bill without a free credit puts a £1 hold on your card. When you close the bill, we take only what
          your guests owe of it (they pay it back to you with their share), and release the rest. The service is
          supplied as soon as you share, so the usual 14-day cancellation period doesn’t apply.
        </p>
      </section>

      <section>
        <h2>When we take nothing</h2>
        <p>If nobody joins the bill, or you delete it, we release the hold: nothing is taken.</p>
        <p>A credit spent on a bill nobody joined is given back.</p>
      </section>

      <section>
        <h2>Credits</h2>
        <p>
          Credits are yours as soon as you pay, so the 14-day cancellation period doesn’t apply and they can’t be
          refunded. They never expire.
        </p>
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
