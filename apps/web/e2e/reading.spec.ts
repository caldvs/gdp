/**
 * #136: while the bill is read the lead sees R2 (the photo, rows filling
 * in) and nothing to answer. Once read, Review bill opens on its own. The
 * place comes from the receipt alone; with none on it, none is shown.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { FakeApi, LEAD_BANK, users } from './fakeApi';

const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');
const BILL = '/v1/bills/0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b';

async function lead(browser: Browser, api: FakeApi): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  const page = await ctx.newPage();
  await page.goto('/');
  return page;
}

async function scan(page: Page) {
  await page.locator('input[capture]').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByRole('heading', { name: 'Reading your bill' })).toBeVisible({ timeout: 15_000 });
}

const sent = (api: FakeApi, method: string, p: string) =>
  api.requests.filter((r) => r.method === method && r.path === p).map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);

test('reading asks nothing, then opens Review bill with the receipt’s place', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup', venue: { name: 'd Maiora - Italian Sandwich Shop', address: '84 Tib Street' } });
  api.holdReads = true;
  const page = await lead(browser, api);
  await scan(page);

  await expect(page.getByRole('heading', { name: 'How many of you?' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Where/ })).toHaveCount(0);
  await expect(page.locator('input:not([type=file])')).toHaveCount(0);

  api.holdReads = false;
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^d Maiora - Italian Sandwich Shop · 5 items/)).toBeVisible();
  expect(api.requests.some((r) => r.path === '/v1/venues/nearby')).toBe(false);
});

test('no place on the receipt: none shown, none asked, and the table has no party size', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup', venue: null });
  const page = await lead(browser, api);
  await scan(page).catch(() => undefined);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^5 items/)).toBeVisible();
  await expect(page.getByLabel('Where was this?')).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await page.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await page.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
  expect(sent(api, 'POST', '/v1/sessions')[0]).not.toHaveProperty('expectedDiners');
  expect(sent(api, 'POST', `${BILL}/amend`).some((b) => b.venue)).toBe(false);
});
