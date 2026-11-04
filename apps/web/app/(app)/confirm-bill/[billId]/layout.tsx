import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Review bill · Pay Me Back' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
