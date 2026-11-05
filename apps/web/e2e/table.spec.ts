/**
 * The bill stays open until the lead closes it.
 *
 * Sam splits the calamari two ways, pays, and the lead confirms. That must
 * NOT settle the bill: the other seat in the split is still empty. Tom
 * joins late, takes the seat, and only then does the lead close.
 *
 * Runs against the in-memory FakeApi, one browser context per diner.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  return ctx.newPage();
}

test('everyone paying does not close the bill; a late guest can still take a split seat', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);

  // --- Sam: split the calamari two ways, take the lasagne, pay.
  await sam.goto(`/session/${SID}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await sam.getByRole('button', { name: 'Split Calamari' }).click();
  await sam.getByRole('button', { name: '£11.25 each' }).click();
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£28.50');
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('dialog', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('Callum will confirm')).toBeVisible();

  // --- Lead: Sam says they've sent it. Confirm. The bill must stay open.
  await lead.goto(`/session/${SID}`);
  await expect(lead.getByText(/^Says they’ve paid/)).toBeVisible();
  await lead.getByRole('button', { name: /Confirm Sam paid/ }).click();
  await expect(lead.getByText(/^Says they’ve paid/)).toHaveCount(0);
  await expect(lead.getByText('Paid', { exact: true })).toBeVisible();
  await expect(lead.getByRole('button', { name: /^Not claimed · / })).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();
  expect(api.status).toBe('claiming');
  // The calamari split still has an empty seat.
  await lead.getByRole('tab', { name: 'Your items' }).click();
  await expect(lead.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible();
  await lead.getByRole('button', { name: 'Done' }).click();

  // --- Tom turns up late and takes the seat.
  const tom = await diner(browser, api, users.tom);
  await tom.goto(`/session/${SID}`);
  await tom.getByRole('button', { name: 'Join the split for Calamari' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');

  // Sam, still watching the table, sees Tom in the split (polling).
  await expect(sam.getByText('Tom').first()).toBeVisible({ timeout: 15_000 });

  // --- Lead closes. Tom hasn't paid yet; the close sheet says so.
  await lead.getByRole('button', { name: 'Close bill' }).click();
  await expect(lead.getByRole('dialog')).toContainText('£11.25 still to collect');
  await lead.getByRole('dialog').getByRole('button', { name: 'Close bill' }).click();
  await expect(lead.getByText('Bill closed')).toBeVisible();
  expect(api.status).toBe('settled');

  // Tom can still pay after the close.
  await expect(tom.getByRole('link', { name: 'Pay Callum £11.25' })).toBeVisible({ timeout: 15_000 });
});
