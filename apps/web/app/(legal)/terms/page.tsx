import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '../legal';

export const metadata: Metadata = { title: 'Terms' };

export default function TermsPage() {
  return (
    <>
      <div className="title">
        <h1>Terms of use</h1>
        <p>Last updated {LEGAL.updated}</p>
      </div>

      <section>
        <h2>Who we are</h2>
        <p>
          Group Dine Pay is run by {LEGAL.operator}, {LEGAL.address}. Contact us at{' '}
          <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>.
        </p>
      </section>

      <section>
        <h2>What the app does</h2>
        <p>
          The lead diner photographs a restaurant bill, checks the items we read from it, and shares a code with the
          table. Each guest picks what they had and pays the lead directly by bank transfer.
        </p>
        <p>
          We never hold or move dinner money. Payments between diners are between them: we are not a party to them,
          and we are not responsible if someone doesn’t pay.
        </p>
      </section>

      <section>
        <h2>Fees</h2>
        <ul>
          <li>Your first bill is free.</li>
          <li>
            After that, sharing a bill costs £2, or £3 if the bill is over £100. The lead pays it by card when they
            share the bill. Card payments are handled by Stripe.
          </li>
          <li>
            The fee is added to what the guests owe, split between them, so they pay it back to the lead with their
            share of the bill.
          </li>
          <li>
            The fee pays for a service we supply straight away. When you pay, you agree to that, which means the
            14-day cancellation period doesn’t apply. See <Link href="/refunds">Refunds</Link> for when we refund it.
          </li>
        </ul>
      </section>

      <section>
        <h2>Reading the bill</h2>
        <p>
          Bills are read automatically and can be wrong. The lead should check the items and totals before sharing,
          and everyone should check what they owe before paying.
        </p>
      </section>

      <section>
        <h2>Accounts</h2>
        <p>
          You can use the app without an account. If you create one, you sign in with a code sent to your email. Keep
          access to that email to yourself. You can delete your account at any time from the account page.
        </p>
      </section>

      <section>
        <h2>Fair use</h2>
        <p>
          Don’t use the app to break the law, to mislead people about what they owe, or to interfere with the service.
          We may close accounts that do.
        </p>
      </section>

      <section>
        <h2>Our responsibility</h2>
        <p>
          We provide the app as it is and will do our best to keep it working. Unless the law says otherwise, our
          total liability to you is limited to the fees you paid us in the 12 months before the claim. Nothing in
          these terms limits liability that the law doesn’t allow us to limit, or your statutory rights as a
          consumer.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>We may update these terms. The date at the top shows when they last changed.</p>
      </section>

      <section>
        <h2>Law</h2>
        <p>These terms are governed by the law of England and Wales.</p>
      </section>
    </>
  );
}
