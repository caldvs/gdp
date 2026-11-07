/**
 * Renders a real page of the app in Storybook at phone size: the page in
 * AppShell (or the front door's header), a fresh React Query cache, and the
 * e2e suite's in-memory API answering every request (stories/fakeFetch.ts),
 * so each story is the screen that ships, in one state from the redesign
 * board. Nothing here reaches a server.
 *
 *   parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}` })
 *
 * `path` sets usePathname/useParams/useSearchParams; a story's `play` clicks
 * on to states a URL can't reach (a dialog, a tab, a claim).
 */
import type { Decorator, Parameters } from '@storybook/nextjs-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { configureApi, registerQueryClient, type components } from '@gdp/core/api';
import { storeSessionPayoutFromFragment } from '@gdp/core/lib/sessionPayout';
import { AppShell, Header } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';
import { BID, FakeCore, LEAD_BANK, SID, type User } from '../../e2e/fakeCore';
import { installFake } from '../fakeFetch';

type BillingSummary = components['schemas']['BillingSummary'];

/** The platform fee, which the fake API leaves out (e2e runs without Stripe). */
export type Billing = {
  /** This month's free bill. */
  creditsLeft?: 0 | 1;
  boughtCredits?: number;
  /** This bill's fee: free/credit spends a credit, held/paid is the £1 hold. */
  fee?: 'unpaid' | 'held' | 'paid' | 'free' | 'credit' | 'waived';
};

export type ScreenParams = {
  /** Who's looking. Omit for a signed-out visitor. */
  user?: User;
  /** A guest who joined with just this name (#183). */
  guestName?: string;
  /** The table, built fresh for each story. */
  api?: () => FakeCore;
  /** The URL, with any `?query`. */
  path: string;
  /** Signed-out pages (sign in) have the front door's header and no menu. */
  shell?: 'app' | 'front';
  billing?: Billing;
  /** The lead's bank details in this browser, as a guest who scanned the QR has them. */
  payout?: { monzo?: string; revolut?: string };
};

/** Story parameters for a page. */
export function screen(p: ScreenParams): Parameters {
  const [pathname = '/', search = ''] = p.path.split('?');
  return {
    layout: 'fullscreen',
    phone: true,
    screen: p,
    nextjs: { appDirectory: true, navigation: { pathname, query: Object.fromEntries(new URLSearchParams(search)), segments: Object.entries(routeParams(pathname)) } },
  };
}

/** useParams for the app's dynamic routes. */
function routeParams(pathname: string): Record<string, string> {
  const parts = pathname.split('/').filter(Boolean);
  const keys: Record<string, string> = { session: 'id', 'confirm-bill': 'billId', 'table-fee': 'billId', reading: 'readId', join: 'code' };
  const out: Record<string, string> = {};
  parts.forEach((part, i) => {
    const key = keys[part];
    if (key && parts[i + 1]) out[key] = parts[i + 1]!;
  });
  return out;
}

function billing(b: Billing) {
  const credits = { creditsLeft: b.creditsLeft ?? 1, boughtCredits: b.boughtCredits ?? 0 };
  const at = '2026-10-31T12:05:00Z';
  return (method: string, path: string): unknown => {
    if (path === '/v1/billing/me') {
      const summary: BillingSummary = {
        ...credits,
        packs: [],
        nextCreditOn: '2026-12-01',
        paidPence: b.fee === 'paid' ? 100 : 0,
        refundedPence: 0,
        // This bill's fee or credit, so the share page and the bill say what paid for it.
        fees: b.fee === 'paid' || b.fee === 'held' ? [{ billId: BID, sessionId: SID, amountPence: 100, paidAt: at, kind: 'hold', ...(b.fee === 'paid' ? { capturedPence: 100, capturedAt: at } : {}) }] : [],
        credits: b.fee === 'free' || b.fee === 'credit' ? [{ month: '2026-10', billId: BID, sessionId: SID, claimedAt: at }] : [],
      };
      return summary;
    }
    if (path.startsWith('/v1/billing/table-fee/')) {
      const status = b.fee ?? 'unpaid';
      return { billId: BID, status, amountPence: 100, ...credits, ...(status === 'paid' ? { paidAt: at } : {}) };
    }
    if (path === '/v1/billing/table-fee' && method === 'POST') return { client_secret: 'cs_test_storybook', amountPence: 100 };
    return undefined;
  };
}

/** The lead's details as the QR's #p= carries them (ADR-0002). */
function payoutFragment(p: { monzo?: string; revolut?: string }): string {
  const payload = { v: 1, n: LEAD_BANK.accountHolderName, s: LEAD_BANK.sortCode, a: LEAD_BANK.accountNumber, iat: Math.floor(Date.now() / 1000), ...(p.monzo ? { m: p.monzo } : {}), ...(p.revolut ? { r: p.revolut } : {}) };
  return `#p=${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const VISITOR: User = { userId: 'u-visitor', displayName: 'Visitor', email: 'visitor@example.com' };

function useScreen(p: ScreenParams): QueryClient {
  const [qc] = useState(() => {
    configureApi({ baseUrl: window.location.origin });
    const api = p.api?.() ?? new FakeCore();
    const user = p.user ?? VISITOR;
    sessionStorage.clear();
    localStorage.clear();
    if (p.guestName) {
      api.guestNames.set(user.userId, p.guestName);
      api.join({ ...user, displayName: p.guestName });
    } else if (p.user) {
      api.join(user);
    }
    installFake(api, user, { token: p.guestName ? 'guest-token' : p.user ? 'test-token' : null, extra: billing(p.billing ?? {}) });
    if (p.payout) storeSessionPayoutFromFragment(SID, payoutFragment(p.payout));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
    registerQueryClient(client);
    return client;
  });
  return qc;
}

function ScreenFrame({ p, children }: { p: ScreenParams; children: ReactNode }) {
  const qc = useScreen(p);
  return (
    <div className="sb-phone" style={{ width: 390, minHeight: 844, margin: '0 auto', background: 'var(--page)', boxShadow: '0 0 0 1px var(--card-line)' }}>
      <style>{'.sb-phone .app { min-height: 844px; }'}</style>
      <QueryClientProvider client={qc}>
        {p.shell === 'front' ? (
          <div className="app">
            <Header wide />
            {children}
          </div>
        ) : (
          <AppShell><PageTransition>{children}</PageTransition></AppShell>
        )}
      </QueryClientProvider>
    </div>
  );
}

/** Wraps every story whose parameters come from screen(). */
export const withScreen: Decorator = (Story, ctx) => {
  const p = ctx.parameters.screen as ScreenParams | undefined;
  if (!p) return <Story />;
  return <ScreenFrame key={ctx.id} p={p}><Story /></ScreenFrame>;
};
