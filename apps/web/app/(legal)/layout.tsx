import Link from 'next/link';
import { Header } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';

/** Public pages anyone can read, signed in or not: no auth gate. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <Header />
      <PageTransition>
        <div className="page legal">
          {children}
          <nav className="legal__nav" aria-label="Legal">
            <Link href="/help">Help</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/refunds">Refunds</Link>
          </nav>
        </div>
      </PageTransition>
    </div>
  );
}
