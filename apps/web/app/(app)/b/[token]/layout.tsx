import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Your bill · Pay Me Back' }, referrer: 'no-referrer' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
