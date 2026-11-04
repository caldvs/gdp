/**
 * Auth, account, history, and riding out a flaky network.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User, opts: Parameters<FakeApi['attach']>[2] = {}): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user, opts);
  return ctx.newPage();
}

test('idle for over an hour: signed out on the next visit, with where you were going kept', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam, { lastActiveAgoMs: 2 * 3600_000 });
  await sam.goto(`/session/${SID}`);
  await expect(sam).toHaveURL(new RegExp(`/sign-in\\?from=${encodeURIComponent(`/session/${SID}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
});

test('history: All / Hosted / Joined, and a joined row shows the tick only once paid', async ({ browser }) => {
  const api = new FakeApi();
  const base = { creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: 'b', pinnedBillVersion: 1 };
  api.mySessions = [
    { ...base, sessionId: SID, status: 'claiming', role: 'lead', venue: { name: 'Gennaro' }, createdAt: new Date().toISOString(), myPaymentStatus: 'self_paid' },
    { ...base, sessionId: 's2', status: 'settled', role: 'diner', venue: { name: 'Dishoom' }, createdAt: new Date(Date.now() - 864e5).toISOString(), myPaymentStatus: 'succeeded', myOwedPence: 2840 },
    { ...base, sessionId: 's3', status: 'settled', role: 'lead', venue: { name: 'Bundobust' }, createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), myPaymentStatus: 'self_paid' },
    { ...base, sessionId: 's4', status: 'claiming', role: 'diner', venue: { name: 'Rudy’s' }, createdAt: new Date(Date.now() - 9 * 864e5).toISOString(), myPaymentStatus: 'unpaid', myOwedPence: 1550 },
  ];
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/history');
  const rows = lead.locator('.box a.row');
  await expect(rows).toHaveCount(4);

  await lead.getByLabel('Show').selectOption('hosted');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Gennaro');
  await expect(rows.first()).toContainText('Open');
  await expect(rows.nth(1)).toContainText('Closed');

  await lead.getByLabel('Show').selectOption('joined');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Dishoom' }).locator('.badge--ok')).toContainText('£28.40');
  await expect(rows.filter({ hasText: 'Rudy’s' }).locator('.badge--ok')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Rudy’s' })).toContainText('£15.50');
});

test('menu → account → sign out → the front door, and a deep link afterwards asks you to sign in', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/');
  await lead.getByRole('button', { name: 'Open menu' }).click();
  await lead.getByRole('link', { name: 'Account' }).click();
  await expect(lead.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(lead.getByText('callum@example.com')).toBeVisible();
  await lead.getByRole('button', { name: 'Sign out' }).click();
  await expect(lead).toHaveURL(/\/sign-in$/);
  expect(await lead.evaluate(() => localStorage.getItem('gdp.idToken'))).toBeNull();
  // Signing out ends the account's sessions on every device (#155).
  expect(api.signedOutEverywhere).toEqual([users.lead.userId]);
});

test('a failed poll doesn’t blank the table; the next one recovers', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}`);
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();
  api.faults.push({ kind: 'session-get-500', times: 1 });
  api.join(users.sam);
  // Across the failed poll the table stays up, then Sam appears.
  await expect(lead.getByText('Sam', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();
});

test('starting a payment fails once: Try again works and only one payment is open', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.goto(`/session/${SID}`);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  api.faults.push({ kind: 'initiate-500', times: 1 });
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByRole('alert').filter({ hasText: /boom|Couldn|Our side/ }).or(sam.getByText('boom')).first()).toBeVisible();
  await sam.getByRole('button', { name: 'Try again' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  const initiates = api.requests.filter((r) => r.method === 'POST' && r.path === `/v1/sessions/${SID}/payments`);
  expect(initiates.length).toBe(2);
  expect(api.participants.find((p) => p.userId === 'u-sam')!.payment.status).toBe('pending');
});
