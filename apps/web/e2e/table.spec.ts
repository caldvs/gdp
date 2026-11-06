/**
 * The bill stays open until the lead closes it.
 *
 * Sam is splitting the calamari two ways, pays, and the lead confirms. That must
 * NOT settle the bill: the other seat in the split is still empty. Tom
 * joins late, takes the seat, and only then does the lead close.
 *
 * Runs against the in-memory FakeApi, one browser context per diner.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, items, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  return ctx.newPage();
}

test('everyone paying does not close the bill; a late guest can still take a split seat', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  // Sam is splitting the calamari two ways and has the other seat to fill.
  api.join(users.sam);
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-sam'], ways: 2, activity: [] });
  api.participants.find((p) => p.userId === 'u-sam')!.sharedItemIds = [items[1]!.itemId];

  // --- Sam: take the lasagne, pay.
  await sam.goto(`/session/${SID}`);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£28.50');
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('Gennaro Sam')).toBeVisible();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('Waiting for Callum to mark it received')).toBeVisible();

  // --- Lead: Sam says they've sent it. Received. The bill must stay open.
  await lead.goto(`/session/${SID}`);
  await expect(lead.getByText(/^Says they’ve paid/)).toBeVisible();
  await lead.getByRole('button', { name: /^Sam’s £[\d.]+ received$/ }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();
  await expect(lead.getByText(/^Says they’ve paid/)).toHaveCount(0);
  await expect(lead.getByText('Paid', { exact: true })).toBeVisible();
  await expect(lead.getByRole('list', { name: 'What needs you' })).toContainText('nobody’s claimed');
  await expect(lead.getByRole('button', { name: 'Mark as settled' })).toBeVisible();
  expect(api.status).toBe('claiming');
  // The calamari split still has an empty seat.
  await expect(lead.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible();

  // --- Tom turns up late and takes the seat.
  const tom = await diner(browser, api, users.tom);
  await tom.goto(`/session/${SID}`);
  await tom.getByRole('button', { name: 'Join the split for Calamari' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');

  // --- Lead settles. Tom hasn't paid yet; the confirm says so.
  await lead.getByRole('button', { name: 'Mark as settled' }).click();
  await expect(lead.getByRole('group', { name: 'Mark the bill as settled?' })).toContainText('Still to come£11.25');
  await lead.getByRole('group', { name: 'Mark the bill as settled?' }).getByRole('button', { name: 'Mark as settled' }).click();
  await expect(lead.getByText('Settled', { exact: true })).toBeVisible();
  expect(api.status).toBe('settled');

  // Tom can still pay after the close.
  await expect(tom.getByRole('link', { name: 'Pay Callum £11.25' })).toBeVisible({ timeout: 15_000 });
});
