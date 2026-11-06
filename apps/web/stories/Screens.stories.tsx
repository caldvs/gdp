import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { configureApi, registerQueryClient } from '@gdp/core/api';
import { AppShell } from '@/components/AppShell';
import { PageTransition } from '@/components/PageTransition';
import BillsPage from '@/app/(app)/page';
import SessionPage from '@/app/(app)/session/[id]/page';
import { FakeCore, SID, items, users, type User } from '../e2e/fakeCore';
import { as, installFake } from './fakeFetch';

/**
 * Whole screens: the app's real pages in its real shell, fed by the e2e
 * suite's in-memory API (e2e/fakeCore.ts), so a story is the page as it
 * is today and its buttons work (Received, Claim, the tabs). Each story
 * sets up a table by acting as the people at it, as the app would.
 */
configureApi({ baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin });

const meta = { title: 'Screens', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// Olives are the lead's (FakeCore's default).
const [, calamari, lasagne, negroni, martini] = items.map((i) => i.itemId) as [string, string, string, string, string];
const path = (p: string) => `/v1/sessions/${SID}${p}`;

/** Gennaro, mid-meal: Priya's paid, Sam says he has, Tom hasn't yet, two Espresso Martinis unclaimed. */
function midMeal(opts: { leadClaims?: string[] } = {}): FakeCore {
  const api = new FakeCore({ serviceRate: 0.125, ...(opts.leadClaims ? { leadClaims: opts.leadClaims } : {}) });
  api.expectedDiners = 4;
  for (const u of [users.sam, users.tom, users.priya]) api.join(u);
  const sam = as(api, users.sam);
  const tom = as(api, users.tom);
  const priya = as(api, users.priya);
  sam.post(path('/claims'), { claimedItemIds: [lasagne, negroni] });
  tom.post(path('/claims'), { claimedItemIds: [calamari] });
  priya.post(path('/claims'), { claimedItemIds: [negroni, martini] });
  const opened = sam.post(path('/payments')) as { payment: { paymentId: string } };
  sam.post(`/v1/payments/${opened.payment.paymentId}/mark-paid`);
  as(api, users.lead).post(path(`/participants/${users.priya.userId}/received`));
  return api;
}

function Screen({ build, user, page: Page }: { build: () => FakeCore; user: User; page: ComponentType }) {
  const [qc] = useState(() => {
    installFake(build(), user);
    const q = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    registerQueryClient(q);
    return q;
  });
  return (
    <QueryClientProvider client={qc}>
      <div className="app">
        <AppShell><PageTransition><Page /></PageTransition></AppShell>
      </div>
    </QueryClientProvider>
  );
}

const atBill = { nextjs: { appDirectory: true, navigation: { pathname: `/session/${SID}`, segments: [['id', SID]] } } };
const atHome = { nextjs: { appDirectory: true, navigation: { pathname: '/' } } };

export const Bills: Story = {
  parameters: atHome,
  render: () => (
    <Screen
      user={users.lead}
      page={BillsPage}
      build={() => {
        const api = midMeal();
        const base = { creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: 'b', pinnedBillVersion: 1 };
        const day = 864e5;
        api.mySessions = [
          { ...base, sessionId: SID, status: 'claiming', role: 'lead', venue: { name: 'Gennaro' }, createdAt: new Date().toISOString(), myPaymentStatus: 'self_paid' },
          { ...base, sessionId: 's2', status: 'settled', role: 'diner', venue: { name: 'Dishoom' }, createdAt: new Date(Date.now() - 3 * day).toISOString(), myPaymentStatus: 'succeeded', billTotalPence: 9600, mySharePence: 2840 },
          { ...base, sessionId: 's3', status: 'settled', role: 'lead', venue: { name: 'Bundobust' }, createdAt: new Date(Date.now() - 8 * day).toISOString(), myPaymentStatus: 'self_paid', billTotalPence: 14250, mySharePence: 3100 },
        ];
        return api;
      }}
    />
  ),
};

export const LeadTheTable: Story = {
  name: 'Lead: the table',
  parameters: atBill,
  render: () => <Screen user={users.lead} page={SessionPage} build={() => midMeal()} />,
};

export const LeadYourItems: Story = {
  name: 'Lead: your items',
  parameters: atBill,
  // Nothing claimed yet, so the lead lands on Your items.
  render: () => <Screen user={users.lead} page={SessionPage} build={() => midMeal({ leadClaims: [] })} />,
};

export const LeadNotShared: Story = {
  name: 'Lead: not shared yet',
  parameters: atBill,
  render: () => <Screen user={users.lead} page={SessionPage} build={() => new FakeCore({ serviceRate: 0.125, status: 'setup' })} />,
};

export const LeadClosed: Story = {
  name: 'Lead: closed',
  parameters: atBill,
  render: () => (
    <Screen
      user={users.lead}
      page={SessionPage}
      build={() => {
        const api = midMeal();
        as(api, users.lead).post(path('/close'));
        return api;
      }}
    />
  ),
};

export const GuestPicking: Story = {
  name: 'Guest: picking',
  parameters: atBill,
  render: () => <Screen user={users.tom} page={SessionPage} build={() => midMeal()} />,
};

export const GuestSaysPaid: Story = {
  name: 'Guest: says they’ve paid',
  parameters: atBill,
  render: () => <Screen user={users.sam} page={SessionPage} build={() => midMeal()} />,
};

export const GuestReceived: Story = {
  name: 'Guest: lead marked received',
  parameters: atBill,
  render: () => <Screen user={users.priya} page={SessionPage} build={() => midMeal()} />,
};
