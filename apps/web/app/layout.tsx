import type { Metadata, Viewport } from 'next';
import { DEMO_MODE } from '@gdp/core/lib/demoMode';
import { SafeAnalytics } from '@/components/SafeAnalytics';
import { fontClasses } from './fonts';
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
  themeColor: '#0095f7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={fontClasses}>
      <body>
        <Providers>{children}</Providers>
        <SafeAnalytics />
      </body>
    </html>
  );
}
