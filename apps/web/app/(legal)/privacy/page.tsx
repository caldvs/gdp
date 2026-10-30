import type { Metadata } from 'next';
import { LEGAL } from '../legal';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <>
      <div className="title">
        <h1>Privacy</h1>
        <p>Last updated {LEGAL.updated}</p>
      </div>

      <section>
        <p>
          {LEGAL.operator} runs Group Dine Pay and is responsible for your data under UK data protection law. Contact{' '}
          <a href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a> with any question or request.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Your email address</strong>, if you sign in, so we can send you a sign-in code.
          </li>
          <li>
            <strong>Your name</strong>, so the table knows who has picked and paid.
          </li>
          <li>
            <strong>Bill photos</strong> and the items and prices we read from them, plus the restaurant’s name.
          </li>
          <li>
            <strong>What happens at the table:</strong> who picked which items, who has said they’ve paid, and when the
            bill was closed.
          </li>
          <li>
            <strong>Fee payments:</strong> the amount, date and Stripe’s reference. Stripe handles your card; we never
            see or store card numbers.
          </li>
        </ul>
      </section>

      <section>
        <h2>Bank details</h2>
        <p>
          The lead’s bank details stay in the lead’s own browser. They reach guests inside the invite link itself and
          are never sent to or stored on our servers.
        </p>
      </section>

      <section>
        <h2>Why we use it</h2>
        <p>
          To run the service you asked for (our contract with you), to take fee payments, and to keep records the law
          requires, such as payment records for tax. We don’t sell your data or use it for advertising.
        </p>
      </section>

      <section>
        <h2>Who helps us</h2>
        <ul>
          <li>Amazon Web Services hosts the app and stores data in London.</li>
          <li>Amazon Web Services reads bill photos (Claude, on Amazon Bedrock) in the EU, and looks up the restaurant (Amazon Location Service).</li>
          <li>Stripe takes fee payments.</li>
          <li>Amazon SES sends sign-in emails.</li>
        </ul>
        <p>Some of these may process data outside the UK, under the safeguards UK law requires.</p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <ul>
          <li>A live table and who picked what: 30 days.</li>
          <li>Bill photos: deleted after a year.</li>
          <li>Your account and bill history: until you delete your account.</li>
          <li>Fee payment records: six years, for tax.</li>
        </ul>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          You can ask for a copy of your data, ask us to correct or delete it, or object to how we use it. Email us
          and we’ll reply within a month. If you’re unhappy with our answer, you can complain to the Information
          Commissioner’s Office at <a href="https://ico.org.uk">ico.org.uk</a>.
        </p>
      </section>

      <section>
        <h2>Cookies</h2>
        <p>We use only what’s needed to keep you signed in. No tracking or advertising cookies.</p>
      </section>
    </>
  );
}
