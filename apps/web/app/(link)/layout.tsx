'use client';

import { Header } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';

/** Pages reached from an email. No sign-in gate: they sign you in. */
export default function LinkLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <Header />
      <PageTransition>{children}</PageTransition>
    </div>
  );
}
