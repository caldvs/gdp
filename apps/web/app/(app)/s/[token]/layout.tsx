import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Stop reminders · Pay Me Back' }, referrer: 'no-referrer' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
