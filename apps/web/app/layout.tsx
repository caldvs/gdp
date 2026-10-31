import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { DEMO_MODE } from '@gdp/core/lib/demoMode';
import { Providers } from './providers';
import './globals.css';
import './glass.css';

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'Group Dine Pay', template: '%s · Group Dine Pay' },
  description: 'Snap the bill, share a QR, get paid direct. Your friends don’t install anything.',
  robots: DEMO_MODE ? { index: false, follow: false } : undefined,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B0C0E',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" data-theme="dark" className={inter.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
