import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Credits · Pay Me Back' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
