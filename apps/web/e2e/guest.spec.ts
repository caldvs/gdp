/**
 * The guest's journey: joining by link and by code, the bank details that
 * ride in the link (and never leave the browser), paying, and the table
 * after the lead closes.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CODE, FakeApi, SID, SIGN_IN_CODE, SIGN_IN_LINK_TOKEN, items, users, type User } from './fakeApi';
import { fragmentFor, payoutCheckFor, LEAD_BANK } from './fakeApi';

const POLL = { timeout: 10_000 };

async function ctxFor(browser: Browser, api: FakeApi, user: User, opts: Parameters<FakeApi['attach']>[2] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  // Clipboard permissions only exist in Chromium; WebKit rejects them.
  const chromium = browser.browserType().name() === 'chromium';
  const ctx = await browser.newContext(chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await api.attach(ctx, user, opts);
  return { ctx, page: await ctx.newPage() };
}

/**
 * Ask for a link, then open it the way a phone often does: in another
 * browser (the mail app's), which shares nothing with this tab. The tab
 * that asked must sign itself in from its own poll.
 */
async function signInWithLink(browser: Browser, api: FakeApi, page: Page) {
  await page.getByLabel('Email').fill('sam@example.com');
  await page.locator('form:has(#email) button[type="submit"]').click();
  await expect(page.getByText('Check your email')).toBeVisible();
  // The asking tab shows a number; the link's page asks about it before signing anyone in (#138).
  await expect(page.getByTestId('sign-in-code')).toHaveText(SIGN_IN_CODE);
  const { ctx: mailApp, page: linkTab } = await ctxFor(browser, api, users.sam, { signedIn: false });
  await linkTab.goto(`/sign-in/verify#t=${SIGN_IN_LINK_TOKEN}`);
  await expect(linkTab.getByRole('heading', { name: `Signing in the tab showing ${SIGN_IN_CODE}?` })).toBeVisible();
  expect(api.signIn).toBe('pending');
  await linkTab.getByRole('button', { name: 'Yes' }).click();
  await expect(linkTab.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  await expect(linkTab.getByText('Go back to your other tab.')).toBeVisible();
  // The token doesn't stay in the address bar or history.
  expect(linkTab.url()).not.toContain(SIGN_IN_LINK_TOKEN);
  await mailApp.close();
}

test('join link, signed out: the invite names the host, and the bank details in the fragment never reach a server', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam, { signedIn: false });
  const fragment = fragmentFor();

  await sam.goto(`/join/${CODE}#p=${fragment}`);
  await expect(sam).toHaveURL(new RegExp(`/sign-in\\?from=%2Fjoin%2F${CODE}$`));
  await expect(sam.getByRole('heading', { name: 'Join Callum’s bill' })).toBeVisible();
  await expect(sam.getByText(`Code ${CODE}`)).toBeVisible();

  // The tab that asked carries on to the join by itself once the link is opened.
  await signInWithLink(browser, api, sam);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
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

test('a sign-in someone else started: No at the link signs nobody in (#138)', async ({ browser }) => {
  const api = new FakeApi();
  const { page: asker } = await ctxFor(browser, api, users.sam, { signedIn: false });
  await asker.goto('/sign-in/email');
  await asker.getByLabel('Email').fill('sam@example.com');
  await asker.locator('form:has(#email) button[type="submit"]').click();
  await expect(asker.getByText('Check your email')).toBeVisible();
  const { ctx: mailApp, page: linkTab } = await ctxFor(browser, api, users.sam, { signedIn: false });
  await linkTab.goto(`/sign-in/verify#t=${SIGN_IN_LINK_TOKEN}`);
  await linkTab.getByRole('button', { name: 'No' }).click();
  await expect(linkTab.getByRole('heading', { name: 'Not signed in' })).toBeVisible();
  expect(api.signIn).toBe('denied');
  // The tab that asked never gets a session.
  await expect(asker.getByText('Link expired. Send a new one.')).toBeVisible(POLL);
  await mailApp.close();
});

test('a join link with someone else’s bank details is caught, and they’re never shown (#151)', async ({ browser }) => {
  const api = new FakeApi();
  api.payoutCheck = payoutCheckFor(LEAD_BANK);
  const { page: sam } = await ctxFor(browser, api, users.sam);
  // A re-posted link: the lead's code, but a different account in the fragment.
  const real = JSON.parse(Buffer.from(fragmentFor(), 'base64url').toString()) as Record<string, unknown>;
  const swapped = Buffer.from(JSON.stringify({ ...real, a: '12345678' })).toString('base64url');
  await sam.goto(`/join/${CODE}#p=${swapped}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('These aren’t Callum’s bank details.')).toBeVisible();
  await expect(sam.getByText('12345678')).toHaveCount(0);
});

test('the lead’s share page tells the session what its link’s details hash to (#151)', async ({ browser }) => {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  await ctx.addInitScript((bank) => localStorage.setItem('gdp.payoutAccount', JSON.stringify(bank)), LEAD_BANK);
  const lead = await ctx.newPage();
  await lead.goto(`/session/${SID}/share`);
  await expect.poll(() => api.payoutCheck, POLL).toBe(payoutCheckFor(LEAD_BANK));
  // Never the details themselves.
  for (const r of api.requests) expect(r.body ?? '').not.toContain(LEAD_BANK.accountNumber);
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
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  // The fake's initiate carries no server-side bank details here.
  api.participants.find((p) => p.userId === 'u-sam')!.payment = { status: 'unpaid' };
  await expect(sam.getByText('04-06-68').or(sam.getByText('No bank details from Callum yet.'))).toBeVisible();
});

test('Monzo and Revolut buttons appear only when the lead has the handles; Monzo carries amount and reference', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await sam.getByRole('button', { name: 'Claim Calamari' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByRole('link', { name: 'Pay with Monzo' })).toHaveAttribute('href', 'https://monzo.me/callum.davies/22.50?d=gdp-0193ab12');
  await expect(sam.getByRole('link', { name: 'Pay with Revolut' })).toHaveAttribute('href', 'https://revolut.me/callumd');

  const api2 = new FakeApi();
  const { page: tom } = await ctxFor(browser, api2, users.tom);
  await tom.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await tom.getByRole('button', { name: 'Claim Calamari' }).click(POLL);
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
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click(POLL);
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
