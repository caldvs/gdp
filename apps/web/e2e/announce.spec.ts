/**
 * Screen reader announcements and names (#197, #198, #204): form errors,
 * joins and payments on the lead's table, Copied, the Confirm dialog's
 * body, and the masked account number.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { CODE, FakeApi, LEAD_BANK, SID, fragmentFor, items, users, type User } from './fakeApi';

// A poll is every 5s; leave room for a slow machine.
const POLL = { timeout: 15_000 };

async function diner(browser: Browser, api: FakeApi, user: User, goto: string, opts: { clipboard?: boolean; signedIn?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext(opts.clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await api.attach(ctx, user, opts.signedIn === false ? { signedIn: false, atTable: false } : {});
  const page = await ctx.newPage();
  await page.goto(goto);
  return page;
}

test('#197: a bad email is announced as an alert and describes the field', async ({ browser }) => {
  const page = await diner(browser, new FakeApi(), users.sam, '/sign-in/email', { signedIn: false });
  await page.getByLabel('Email').fill('not an email');
  await page.locator('form:has(#email) button[type="submit"]').click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toHaveText("That doesn't look like an email address.");
  await expect(page.getByLabel('Email')).toHaveAccessibleDescription("That doesn't look like an email address.");
});

test('#197: a failed save of bank details moves focus to the first wrong field', async ({ browser }) => {
  const page = await diner(browser, new FakeApi(), users.lead, '/payout-account');
  const name = page.getByLabel('Name on the account');
  const sort = page.getByLabel('Sort code');
  const account = page.getByLabel('Account number');

  // Name missing, the rest fine: back to the name.
  await sort.fill(LEAD_BANK.sortCode);
  await account.fill(LEAD_BANK.accountNumber);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription('Whose account is this?');

  // Then a short sort code and account number: the sort code first.
  await name.fill(LEAD_BANK.accountHolderName);
  await sort.fill('12');
  await account.fill('123');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(sort).toBeFocused();
  await expect(sort).toHaveAccessibleDescription('Six digits');
});

test('#198: the lead hears who joins and who says they’ve paid', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/session/${SID}`);
  const feed = lead.getByTestId('table-feed');
  await expect(lead.getByRole('tab', { name: 'The table' })).toBeVisible();
  await expect(feed).toHaveAttribute('aria-live', 'polite');
  await expect(feed).toHaveText('');

  api.join(users.sam);
  await expect(feed).toHaveText('Sam joined.', POLL);

  const sam = api.participants[1]!;
  sam.claimedItemIds = [items[1]!.itemId];
  sam.payment = { status: 'pending', paymentId: 'pay-u-sam', payerClaimedPaidAt: '2026-10-31T12:30:00Z' };
  await expect(feed).toHaveText('Sam says they’ve paid £22.50.', POLL);
});

test('#198: the QR page says who has just joined', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/session/${SID}/share`);
  const feed = lead.getByTestId('table-feed');
  await expect(lead.getByText('People appear here as they join.')).toBeVisible();
  await expect(feed).toHaveText('');
  api.join(users.tom);
  await expect(feed).toHaveText('Tom joined.', POLL);
});

test('#198: copying a bank detail is announced', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'copying needs Chromium clipboard permissions');
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam, `/join/${CODE}#p=${fragmentFor()}`, { clipboard: true });
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'Copy sort code' }).click();
  await expect(sam.getByRole('status').filter({ hasText: 'Sort code copied' })).toHaveCount(1);
});

test('#198: the summary’s Copied and Emailed are announced', async ({ browser, browserName }) => {
  const chromium = browserName === 'chromium';
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/session/${SID}/summary`, { clipboard: chromium });
  await lead.getByRole('button', { name: 'Email this' }).click();
  await expect(lead.getByRole('status').filter({ hasText: /^Emailed$/ })).toHaveCount(1);
  if (chromium) {
    await lead.getByRole('button', { name: 'Copy as text' }).click();
    await expect(lead.getByRole('status').filter({ hasText: /^Copied$/ })).toHaveCount(1);
  }
});

test('#204: the Close and Delete dialogs are described by what they say', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/session/${SID}`);
  await lead.getByRole('button', { name: 'Close bill' }).click();
  const dialog = lead.getByRole('dialog', { name: 'Close the bill?' });
  await expect(dialog).toHaveAccessibleDescription(/It goes on you\./);
  await dialog.getByRole('button', { name: 'Not yet' }).click();

  await lead.getByRole('button', { name: 'More', exact: true }).click();
  await lead.getByRole('button', { name: 'Delete this bill' }).click();
  await expect(lead.getByRole('dialog', { name: 'Delete this bill?' })).toHaveAccessibleDescription('This can’t be undone.');
});

test('#204: the saved account number is read as "account ending", not dots', async ({ browser }) => {
  const page = await diner(browser, new FakeApi(), users.lead, '/payout-account?returnTo=%2Faccount');
  await page.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await page.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await page.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  const bank = page.getByRole('link', { name: /^Bank details/ });
  await expect(bank).toHaveAccessibleName(/04-06-68 · account ending 9660/);
  await expect(bank).not.toHaveAccessibleName(/·{4}/);
  await expect(bank).toContainText('····9660');
});
