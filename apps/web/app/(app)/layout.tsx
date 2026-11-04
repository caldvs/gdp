import type { Metadata } from 'next';
import { AppShell } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';

// The Bills page (/) has no segment of its own, so its title lives here;
// every other route in (app) sets its own in a layout.tsx.
export const metadata: Metadata = { title: { absolute: 'Bills · Pay Me Back' } };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell><PageTransition>{children}</PageTransition></AppShell>;
}
