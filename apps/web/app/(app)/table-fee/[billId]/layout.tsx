import type { Metadata } from 'next';

export const metadata: Metadata = { title: { absolute: 'Get the QR code · Pay Me Back' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
