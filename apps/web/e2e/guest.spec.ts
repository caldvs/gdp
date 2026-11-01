/**
 * The guest's journey: joining by link and by code, the bank details that
 * ride in the link (and never leave the browser), paying, and the table
 * after the lead closes.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CODE, FakeApi, SID, items, users, type User } from './fakeApi';
import { fragmentFor } from './fakeApi';

const POLL = { timeout: 10_000 };

async function ctxFor(browser: Browser, api: FakeApi, user: User, opts: Parameters<FakeApi['attach']>[2] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  // Clipboard permissions only exist in Chromium; WebKit rejects them.
  const chromium = browser.browserType().name() === 'chromium';
  const ctx = await browser.newContext(chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await api.attach(ctx, user, opts);
  return { ctx, page: await ctx.newPage() };
}

async function signInWithCode(page: Page) {
  await page.getByLabel('Email').fill('sam@example.com');
  await page.locator('form button[type="submit"]').click();
  await page.getByLabel('6-digit code').fill('123456');
}

test('join link, signed out: the invite names the host, and the bank details in the fragment never reach a server', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam, { signedIn: false });
  const fragment = fragmentFor();

  await sam.goto(`/join/${CODE}#p=${fragment}`);
  await expect(sam).toHaveURL(new RegExp(`/sign-in\\?from=%2Fjoin%2F${CODE}$`));
  await expect(sam.getByRole('heading', { name: 'Join Callum’s bill' })).toBeVisible();
  await expect(sam.getByText(`Code ${CODE}`)).toBeVisible();

  await signInWithCode(sam);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'Tick Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  // The sort code shown comes from the fragment, formatted.
  await expect(sam.getByText('04-06-68')).toBeVisible();
  await expect(sam.getByText('00079660')).toBeVisible();

  // Never in a URL, never in a request body.
  expect(sam.url()).not.toContain(fragment);
  for (const r of api.requests) {
    expect(r.path).not.toContain(fragment);
    expect(r.body ?? '').not.toContain(fragment);
    expect(r.body ?? '').not.toContain('00079660');
  }
});

test('join by typed code: wrong code shows the error, right code joins', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto('/join');
  await sam.getByLabel('6-letter code').fill('ZZZZZZ');
  await sam.getByRole('button', { name: 'Join' }).click();
  await expect(sam.getByText('Can’t find that code').or(sam.getByText("Can't find that code"))).toBeVisible();

  await sam.getByLabel('6-letter code').fill(CODE.toLowerCase());
  await sam.getByRole('button', { name: 'Join' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
});

test('an expired link leaves the guest without bank details, with a way out', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  // Shared 3 days ago with a 48 h expiry.
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ ageMs: 3 * 24 * 3600_000, ttlMs: 48 * 3600_000 })}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'Tick Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  // The fake's initiate carries no server-side bank details here.
  api.participants.find((p) => p.userId === 'u-sam')!.payment = { status: 'unpaid' };
  await expect(sam.getByText('04-06-68').or(sam.getByText('No bank details from Callum yet.'))).toBeVisible();
});

test('Monzo and Revolut buttons appear only when the lead has the handles; Monzo carries amount and reference', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await sam.getByRole('button', { name: 'Tick Calamari' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByRole('link', { name: 'Pay with Monzo' })).toHaveAttribute('href', 'https://monzo.me/callum.davies/22.50?d=gdp-0193ab12');
  await expect(sam.getByRole('link', { name: 'Pay with Revolut' })).toHaveAttribute('href', 'https://revolut.me/callumd');

  const api2 = new FakeApi();
  const { page: tom } = await ctxFor(browser, api2, users.tom);
  await tom.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await tom.getByRole('button', { name: 'Tick Calamari' }).click(POLL);
  await tom.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(tom.getByText('04-06-68')).toBeVisible();
  await expect(tom.getByRole('link', { name: 'Pay with Monzo' })).toHaveCount(0);
  await expect(tom.getByRole('link', { name: 'Pay with Revolut' })).toHaveCount(0);
});

test('tapping a bank detail copies the raw value', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'reading the clipboard needs Chromium permissions');
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await sam.getByRole('button', { name: 'Tick Lasagne' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'Copy sort code' }).click();
  expect(await sam.evaluate(() => navigator.clipboard.readText())).toBe('040668');
  await sam.getByRole('button', { name: 'Copy Account no.' }).click();
  expect(await sam.evaluate(() => navigator.clipboard.readText())).toBe('00079660');
  await sam.getByRole('button', { name: 'Copy reference' }).click();
  expect(await sam.evaluate(() => navigator.clipboard.readText())).toBe('gdp-0193ab12');
});

test('guest table after the lead closes: what they paid, the tick, Done goes home', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.participants[1]!.claimedItemIds = [items[2]!.itemId];
  api.participants[1]!.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T12:30:00Z' };
  const { page: sam } = await ctxFor(browser, api, users.sam);
  const { page: lead } = await ctxFor(browser, api, users.lead);
  await sam.goto(`/session/${SID}`);
  await expect(sam.getByText('Callum has your')).toBeVisible();
  await expect(sam.getByText('Callum closes the bill once everyone’s paid')).toBeVisible();

  await lead.goto(`/session/${SID}`);
  await lead.getByRole('button', { name: 'Close bill' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Close bill' }).click();

  await expect(sam.getByText('Bill closed')).toBeVisible(POLL);
  await expect(sam.getByText('Callum closes the bill once everyone’s paid')).toHaveCount(0);
  await expect(sam.locator('.totals__line--total')).toContainText('£17.25');
  await sam.getByRole('link', { name: 'Done' }).click();
  await expect(sam).toHaveURL(/\/$/);
});

test('a guest can pass the QR on, and see who’s at the table', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('link', { name: 'QR code' }).click();
  await expect(sam.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
  await expect(sam.getByText(CODE)).toBeVisible();
  await expect(sam.getByText('Pass it on to anyone at Callum’s table.')).toBeVisible();
  const table = sam.getByRole('list', { name: 'At the table' });
  await expect(table).toContainText('Callum');
  await expect(table).toContainText('You');
  // Someone else arrives: they appear without a refresh.
  api.join(users.tom);
  await expect(table).toContainText('Tom', POLL);
  await sam.getByRole('link', { name: 'Back to your items' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
});

test('everyone can open the bill photo', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/session/${SID}`);
  await sam.getByRole('button', { name: 'Bill photo' }).click();
  const dialog = sam.getByRole('dialog', { name: 'Bill photo' });
  // The fake has no image, so it says so rather than spinning forever.
  await expect(dialog).toContainText('The photo isn’t available for this bill.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});
