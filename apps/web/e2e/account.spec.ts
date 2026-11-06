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

const pastSessions = () => {
  const base = { creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: 'b', pinnedBillVersion: 1 };
  return [
    // The fake fills in this one's total and the caller's share from its bill.
    { ...base, sessionId: SID, status: 'claiming', role: 'lead', venue: { name: 'Gennaro' }, createdAt: new Date().toISOString(), myPaymentStatus: 'self_paid' },
    { ...base, sessionId: 's2', status: 'settled', role: 'diner', venue: { name: 'Dishoom' }, createdAt: new Date(Date.now() - 864e5).toISOString(), myPaymentStatus: 'succeeded', billTotalPence: 9600, mySharePence: 2840 },
    { ...base, sessionId: 's3', status: 'settled', role: 'lead', venue: { name: 'Bundobust' }, createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), myPaymentStatus: 'self_paid', billTotalPence: 5000, mySharePence: 1200 },
    // From before totals: only the locked share.
    { ...base, sessionId: 's4', status: 'claiming', role: 'diner', venue: { name: 'Rudy’s' }, createdAt: new Date(Date.now() - 9 * 864e5).toISOString(), myPaymentStatus: 'unpaid', myOwedPence: 1550 },
  ];
};

test('Every bill: by month, All / Hosted / Joined; the host sees the bill’s total, a guest their share, ticked once paid', async ({ browser }) => {
  const api = new FakeApi();
  api.mySessions = pastSessions();
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/history');
  const rows = lead.locator('.box a.row');
  await expect(rows).toHaveCount(4);
  await expect(lead.getByRole('heading', { name: 'Every bill' })).toBeVisible();
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  await expect(lead.getByRole('heading', { name: month })).toBeVisible();

  await lead.getByRole('button', { name: 'Hosted' }).click();
  await expect(lead.getByRole('button', { name: 'Hosted' })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Gennaro');
  await expect(rows.first()).toContainText('hosted · Open');
  await expect(rows.first().locator('.row__end')).toHaveText(`£${(api.bill.totalPence / 100).toFixed(2)}`);
  await expect(rows.nth(1).locator('.row__end')).toHaveText('£50.00');
  await expect(rows.nth(1)).toContainText('hosted · Settled');

  await lead.getByRole('button', { name: 'Joined' }).click();
  await expect(rows).toHaveCount(2);
  const dishoom = rows.filter({ hasText: 'Dishoom' });
  await expect(dishoom.locator('.badge--ok')).toHaveText('Paid £28.40');
  await expect(dishoom).toContainText('joined · Settled · £96.00 bill');
  await expect(rows.filter({ hasText: 'Rudy’s' }).locator('.badge--ok')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Rudy’s' }).locator('.row__end')).toHaveText('£15.50');
});

test('bills: an open bill shows its total to the host and what a guest owes; past ones the same', async ({ browser }) => {
  const api = new FakeApi();
  // Sam has the Calamari: what Sam owes comes from the bill, not a locked amount.
  api.participants.push({ userId: users.sam.userId, displayName: users.sam.displayName, claimedItemIds: [api.items[1]!.itemId], sharedItemIds: [], payment: { status: 'unpaid' }, readyToLock: false });
  api.mySessions = pastSessions();
  const total = `£${(api.bill.totalPence / 100).toFixed(2)}`;

  const lead = await diner(browser, api, users.lead);
  await lead.goto('/');
  const open = lead.locator('.row--card').filter({ hasText: 'Gennaro' });
  // #223: the place, date and people; the money and who still has to pay.
  await expect(open.locator('.row__end')).toHaveText(`${total}1 to pay`);
  await expect(open).toContainText('2 people');
  const past = lead.locator('.box a.row');
  await expect(past.filter({ hasText: 'Bundobust' }).locator('.row__end')).toHaveText('£50.00Settled');
  await expect(past.filter({ hasText: 'Dishoom' }).locator('.row__end')).toHaveText('£28.40Settled');
  await expect(past.filter({ hasText: 'Dishoom' })).toContainText('you joined · £96.00 bill');

  const sam = await diner(browser, api, users.sam);
  api.mySessions = [{ ...pastSessions()[0]!, role: 'diner', myPaymentStatus: 'unpaid' }];
  await sam.goto('/');
  const samRow = sam.locator('.row--card').filter({ hasText: 'Gennaro' });
  await expect(samRow.locator('.badge--warn')).toHaveText('You owe £22.50');
  await expect(samRow).toContainText(`you joined · ${total} bill`);
});

test('menu → account → sign out → the front door, and a deep link afterwards asks you to sign in', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/');
  await lead.getByRole('button', { name: 'Open menu' }).click();
  await lead.getByRole('link', { name: 'Account' }).click();
  await expect(lead.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(lead.getByText('callum@example.com · For your bill emails.')).toBeVisible();
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
  await expect(lead.getByRole('button', { name: 'Mark as settled' })).toBeVisible();
  api.faults.push({ kind: 'session-get-500', times: 1 });
  api.join(users.sam);
  // Across the failed poll the table stays up, then Sam appears.
  await expect(lead.getByText('Sam', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByRole('button', { name: 'Mark as settled' })).toBeVisible();
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
  await expect(sam.getByText('Gennaro Sam')).toBeVisible();
  const initiates = api.requests.filter((r) => r.method === 'POST' && r.path === `/v1/sessions/${SID}/payments`);
  expect(initiates.length).toBe(2);
  expect(api.participants.find((p) => p.userId === 'u-sam')!.payment.status).toBe('pending');
});

test('#224 Account: bank details, the email bill emails go to, Every bill, Sign out', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/account');
  await expect(lead.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(lead.getByRole('link', { name: /^Bank details/ })).toContainText('Not saved');
  await expect(lead.getByText(`${users.lead.email} · For your bill emails.`)).toBeVisible();
  await expect(lead.getByRole('link', { name: 'Credits' })).toHaveCount(0);
  await lead.getByRole('link', { name: 'Every bill' }).click();
  await expect(lead.getByRole('heading', { name: 'Every bill' })).toBeVisible();
});
