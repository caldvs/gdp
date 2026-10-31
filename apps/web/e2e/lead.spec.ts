/**
 * The lead's journey: scan → review → bank details → share, parse errors,
 * fixing the bill mid-session, binning, closing.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { FakeApi, LEAD_BANK, SID, items, users, type User } from './fakeApi';

const POLL = { timeout: 10_000 };
const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');

async function diner(browser: Browser, api: FakeApi, user: User, goto = `/session/${SID}`): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(goto);
  return page;
}

test('snap → check (fix a price, a quantity) → bank details → share; the second bill skips bank details', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  const lead = await diner(browser, api, users.lead, '/');

  await lead.locator('input[capture]').setInputFiles(PHOTO);
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByText('Gennaro · 5 items')).toBeVisible();

  // Fix the calamari's price and make it two.
  await lead.getByRole('button', { name: 'Edit Calamari' }).click();
  await lead.getByLabel('Price each').fill('20.00');
  await lead.getByRole('button', { name: 'One more' }).click();
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByText('£40.00')).toBeVisible();

  // First time: no bank details yet → asked for them, then straight on to share.
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Bank details' })).toBeVisible();
  await lead.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await lead.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await lead.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await lead.getByRole('button', { name: 'Save and continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
  await expect(lead.getByText('K7Q2MX')).toBeVisible();
  // The amend went through with the edited line.
  const amend = api.requests.find((r) => r.path.endsWith('/amend'));
  expect(amend?.body).toContain('"unitPricePence":2000');
  expect(amend?.body).toContain('"quantity":2');

  // Second bill on the same device: bank details are remembered, no detour.
  api.status = 'setup';
  await lead.goto('/');
  await lead.locator('input[capture]').setInputFiles(PHOTO);
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
});

test('parse errors say what went wrong', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, '/');
  const snap = async () => {
    await lead.locator('input[capture]').setInputFiles(PHOTO);
  };

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Failed to reach Gemini API' });
  await snap();
  await expect(lead.getByText('Couldn’t reach the bill reader.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Gemini returned 403', details: { status: 403 } });
  await snap();
  await expect(lead.getByText('The Gemini API key was rejected. Not the photo’s fault.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Gemini output failed schema validation' });
  await snap();
  await expect(lead.getByText('Couldn’t read that one.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'IMAGE_TOO_LARGE', message: 'too big' });
  await snap();
  await expect(lead.getByText('That photo is too big.')).toBeVisible({ timeout: 15_000 });
});

test('fixing the bill mid-session: a picking guest and a sent guest both see the new price', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Tick Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await expect(sam.getByText('Callum will confirm')).toBeVisible();
  await expect(tom.getByText('Lasagne')).toBeVisible();

  await lead.getByRole('link', { name: 'Edit bill' }).click();
  await expect(lead.getByRole('heading', { name: 'Fix the bill' })).toBeVisible();
  await lead.getByRole('button', { name: 'Edit Lasagne' }).click();
  await lead.getByLabel('Price each').fill('19.00');
  await lead.getByRole('button', { name: 'Done' }).click();
  // Edits save themselves when the editor closes.
  await expect(lead.getByRole('button', { name: 'No changes' })).toBeVisible();
  await lead.getByRole('link', { name: 'Bill', exact: true }).click();
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();

  await expect(sam.getByText('£19.00').first()).toBeVisible(POLL);
  await expect(tom.getByText('£19.00').first()).toBeVisible(POLL);
});

test('deleting the bill ends it for everyone at the table', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();

  await lead.getByRole('button', { name: 'Delete this bill' }).click();
  await expect(lead.getByRole('dialog')).toContainText('1 person loses their picks');
  await lead.getByRole('dialog').getByRole('button', { name: 'Delete bill' }).click();
  await expect(lead).toHaveURL(/\/$/);
  await expect(sam.getByRole('heading', { name: 'This bill was deleted' })).toBeVisible(POLL);
  await expect(sam.getByText('Callum deleted it.')).toBeVisible();
});

test('closing with everything claimed and paid: the dialog says so and "your part" adds up', async ({ browser }) => {
  // Lead has Olives (4.25). Sam takes everything else and pays.
  const api = new FakeApi();
  api.join(users.sam);
  const sam = api.participants[1]!;
  sam.claimedItemIds = [items[1]!.itemId, items[2]!.itemId, items[3]!.itemId, items[3]!.itemId, items[4]!.itemId, items[4]!.itemId, items[4]!.itemId];
  sam.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T12:30:00Z' };
  const lead = await diner(browser, api, users.lead);

  await expect(lead.locator('.stat', { hasText: 'To collect' })).toContainText('£0.00');
  await expect(lead.getByRole('heading', { name: 'Items · all claimed' })).toBeVisible();
  await lead.getByRole('button', { name: 'Close bill' }).click();
  await expect(lead.getByRole('dialog')).toContainText('Everyone has paid.');
  await lead.getByRole('dialog').getByRole('button', { name: 'Close bill' }).click();
    await expect(lead.getByText('Bill closed')).toBeVisible();
  // Sam owed 22.50 + 17.25 + 21.00 + 39.00 = 99.75; bill is 104.00; your part = 4.25.
  await expect(lead.getByText('£99.75').first()).toBeVisible();
  await expect(lead.locator('.totals__line', { hasText: 'Your part' })).toContainText('£4.25');
});
