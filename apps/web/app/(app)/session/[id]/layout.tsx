import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Bill · Pay Me Back' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
