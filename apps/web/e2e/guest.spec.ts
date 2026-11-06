/**
 * The guest's journey: joining by link and by code, the bank details that
 * ride in the link (and never leave the browser), paying, and the table
 * after the lead closes.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CODE, FakeApi, PHONE_CODE, SID, SIGN_IN_CODE, items, users, type User } from './fakeApi';
import { fragmentFor, payoutCheckFor, LEAD_BANK } from './fakeApi';

// Another page's change arrives on its next poll (every 5s while claiming):
// allow three, for a busy CI runner with several WebKit pages open.
const POLL = { timeout: 15_000 };

async function ctxFor(browser: Browser, api: FakeApi, user: User, opts: Parameters<FakeApi['attach']>[2] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  // Clipboard permissions only exist in Chromium; WebKit rejects them.
  const chromium = browser.browserType().name() === 'chromium';
  const ctx = await browser.newContext(chromium ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await api.attach(ctx, user, opts);
  return { ctx, page: await ctx.newPage() };
}

/** Ask for a code and type it into the same tab, which carries on to where it was going. */
async function signInWithCode(page: Page) {
  await page.getByLabel('Email').fill('sam@example.com');
  await page.locator('form:has(#email) button[type="submit"]').click();
  await page.getByLabel('Code sent to sam@example.com').fill(SIGN_IN_CODE);
}

test('#183: a guest scans the QR, sees the bill and joins with just a name; the bank details never reach a server', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam, { signedIn: false });
  const fragment = fragmentFor();

  await sam.goto(`/join/${CODE}#p=${fragment}`);
  // No sign-in: the landing page, on the join link itself.
  await expect(sam.getByRole('heading', { name: 'Join Callum’s bill' })).toBeVisible();
  await expect(sam).toHaveURL(new RegExp(`/join/${CODE}$`));
  await expect(sam.getByText('Gennaro')).toBeVisible();
  // #182: the join token is never shown.
  await expect(sam.getByText(CODE)).toHaveCount(0);

  await sam.getByLabel('Your name').fill('Sam');
  await sam.getByRole('button', { name: 'Join the bill' }).click();
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

test('#214: where texts are on, a guest gives their name and number, types the texted code, and is in', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  api.phoneChannel = 'sms';
  const { page: sam } = await ctxFor(browser, api, users.sam, { signedIn: false });
  const fragment = fragmentFor();

  // G1: the bill, then name and number.
  await sam.goto(`/join/${CODE}#p=${fragment}`);
  await expect(sam.getByRole('heading', { name: 'Join Callum’s bill' })).toBeVisible();
  await expect(sam.getByText('Callum sees your name, not your number.')).toBeVisible();
  await sam.getByLabel('Your name').fill('Sam');
  await sam.getByRole('button', { name: 'Text me a code' }).click();
  await expect(sam.locator('main [role=alert], form [role=alert]').first()).toHaveText('Enter a UK mobile number, like 07700 900123.');
  await sam.getByLabel('Your mobile number').fill('07700 900123');
  await sam.getByRole('button', { name: 'Text me a code' }).click();

  // G1.1: the code, which survives a reload while they check their texts.
  await expect(sam.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
  await expect(sam.getByText('Sent to +44 7700 900123 by text. Works for 10 minutes.')).toBeVisible();
  await sam.reload();
  await expect(sam.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
  await sam.getByLabel('4-digit code').fill('0000');
  await expect(sam.locator('main [role=alert], form [role=alert]').first()).toHaveText('Wrong code. 4 tries left.');
  await sam.getByLabel('4-digit code').fill(PHONE_CODE);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  expect(api.verifiedGuestPhones).toEqual(['+447700900123']);

  // The lead's bank details came through the reload, and never left the browser.
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('04-06-68')).toBeVisible();
  for (const r of api.requests) {
    expect(r.path).not.toContain(fragment);
    expect(r.body ?? '').not.toContain(fragment);
  }
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

test('#182: Join a bill has nothing to type; it says to scan the QR', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto('/join');
  await expect(sam.getByRole('heading', { name: 'Join a bill' })).toBeVisible();
  await expect(sam.getByText('Scan the QR code on the lead’s phone with your camera.')).toBeVisible();
  await expect(sam.getByRole('textbox')).toHaveCount(0);
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

test('Monzo and Revolut buttons appear only when the lead has the handles; Monzo carries amount and reference', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await sam.getByRole('button', { name: 'Claim Calamari' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByRole('link', { name: 'Pay with Monzo' })).toHaveAttribute('href', 'https://monzo.me/callum.davies/22.50?d=Gennaro%20Sam');
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
  expect(await sam.evaluate(() => navigator.clipboard.readText())).toBe('Gennaro Sam');
});

test('guest table after the lead closes: what they paid, the tick, Done goes home', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.participants[1]!.claimedItemIds = [items[2]!.itemId];
  api.participants[1]!.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T12:30:00Z' };
  const { page: sam } = await ctxFor(browser, api, users.sam);
  const { page: lead } = await ctxFor(browser, api, users.lead);
  await sam.goto(`/session/${SID}`);
  await expect(sam.getByText('Callum got your')).toBeVisible();
  await expect(sam.getByText('Callum marks the bill as settled once everyone’s paid')).toBeVisible();

  await lead.goto(`/session/${SID}`);
  await lead.getByRole('button', { name: 'Mark as settled' }).click();
  await lead.getByRole('group', { name: 'Mark the bill as settled?' }).getByRole('button', { name: 'Mark as settled' }).click();

  await expect(sam.getByText('Settled', { exact: true })).toBeVisible(POLL);
  await expect(sam.getByText('Callum marks the bill as settled once everyone’s paid')).toHaveCount(0);
  await expect(sam.getByRole('region', { name: 'Your share' })).toContainText('Paid to Callum£17.25');
  await sam.getByRole('link', { name: 'Done' }).click();
  await expect(sam).toHaveURL(/\/$/);
});

test('a guest can pass the QR on, and see who’s at the table', async ({ browser }) => {
  const api = new FakeApi();
  const { page: sam } = await ctxFor(browser, api, users.sam);
  await sam.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible(POLL);
  await sam.getByRole('link', { name: 'QR code' }).click();
  await expect(sam.getByRole('heading', { name: 'Show the table' })).toBeVisible();
  await expect(sam.getByText('Gennaro · £104.00')).toBeVisible();
  await expect(sam.getByText(CODE)).toHaveCount(0);
  await expect(sam.getByRole('button', { name: /copy link|share link/i })).toHaveCount(0);
  await expect(sam.getByText('Show it to anyone at Callum’s table.')).toBeVisible();
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
  await sam.getByRole('button', { name: 'More', exact: true }).click();
  await sam.getByRole('dialog', { name: 'This bill' }).getByRole('button', { name: 'Bill photo' }).click();
  const dialog = sam.getByRole('dialog', { name: 'Bill photo' });
  // The fake has no image, so it says so rather than spinning forever.
  await expect(dialog).toContainText('The photo isn’t available for this bill.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});
