import type { Metadata, Viewport } from 'next';
import { Anton, Plus_Jakarta_Sans } from 'next/font/google';
import { DEMO_MODE } from '@gdp/core/lib/demoMode';
import { SafeAnalytics } from '@/components/SafeAnalytics';
import { Providers } from './providers';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });
// Headings and big amounts (#180).
const anton = Anton({ weight: '400', subsets: ['latin'], variable: '--font-anton', display: 'swap' });

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
    <html lang="en-GB" className={`${jakarta.variable} ${anton.variable}`}>
      <body>
        <Providers>{children}</Providers>
        <SafeAnalytics />
      </body>
    </html>
  );
}
