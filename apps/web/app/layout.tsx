import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { DEMO_MODE } from '@gdp/core/lib/demoMode';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Pay Me Back', template: '%s · Pay Me Back' },
  description: 'Snap the bill, share a QR, get paid direct. Your friends don’t install anything.',
  robots: DEMO_MODE ? { index: false, follow: false } : undefined,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
