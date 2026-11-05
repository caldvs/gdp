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
