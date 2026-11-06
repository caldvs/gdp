/**
 * #121: a guest who has paid can claim something they forgot and pay just
 * the difference. The lead marks money received when it lands; the guest
 * is settled once nothing is due and every payment is confirmed.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

// Another page's change arrives on its next poll (every 5s while claiming):
// allow three, for a busy CI runner with several WebKit pages open.
const POLL = { timeout: 15_000 };

async function at(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

test('paid, then claims more: pays the difference, the lead marks each received', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await at(browser, api, users.lead);
  const sam = await at(browser, api, users.sam);

  // First payment: the lasagne.
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByRole('region', { name: 'Your share' })).toContainText('You pay Callum£17.25');
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('You’ve sent £17.25.')).toBeVisible(POLL);

  await expect(lead.getByText(/^Says they’ve paid £17\.25/)).toBeVisible(POLL);
  await lead.getByRole('button', { name: 'Sam’s £17.25 received' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();
  await expect(sam.getByText('Callum got your £17.25.')).toBeVisible(POLL);

  // Forgot the calamari: back to picking.
  await sam.getByRole('button', { name: 'I had something else' }).click();
  await expect(sam.getByRole('heading', { name: 'What else did you have?' })).toBeVisible();
  // Can't drop what's been paid for: nobody gets money back.
  await sam.getByRole('button', { name: 'Remove Lasagne' }).click();
  await expect(sam.getByText('You’ve already paid for that')).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Remove Lasagne' })).toBeVisible();

  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(sam.getByText('Paid £17.25 · still to pay')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');

  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByRole('region', { name: 'Your share' })).toContainText('You pay Callum£22.50');
  await expect(sam.getByText('The rest, after the £17.25 you’ve paid.', { exact: false })).toBeVisible();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('You’ve sent £22.50.')).toBeVisible(POLL);
  await expect(sam.getByRole('region', { name: 'Your share' })).toContainText('Callum has£17.25');
  await expect(sam.getByRole('region', { name: 'Your share' })).toContainText('Sent to Callum£22.50');

  // The lead sees the second payment and marks it received like the first.
  await expect(lead.getByText(/^Says they’ve paid £22\.50 more/)).toBeVisible(POLL);
  await lead.getByRole('button', { name: 'Sam’s £22.50 received' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();
  await expect(sam.getByText('Callum got your £39.75.')).toBeVisible(POLL);
  await expect(sam.getByRole('heading', { name: 'All square' })).toBeVisible();
  const created = api.requests.filter((r) => r.method === 'POST' && r.path === `/v1/sessions/${SID}/payments`);
  expect(created.length).toBeGreaterThanOrEqual(2);
});

test('a top-up can go before the lead has confirmed the first', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await at(browser, api, users.lead);
  const sam = await at(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await sam.getByRole('button', { name: 'I had something else' }).click();
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('You’ve sent £39.75.')).toBeVisible(POLL);

  // Both sent: one Received covers them.
  await expect(lead.getByText(/^Says they’ve paid £39\.75/)).toBeVisible(POLL);
  await lead.getByRole('button', { name: 'Sam’s £39.75 received' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();
  await expect(lead.getByText('Paid', { exact: true })).toBeVisible(POLL);
  await expect(sam.getByRole('heading', { name: 'All square' })).toBeVisible(POLL);
});

test('the lead sees what each guest has claimed, and marks money received before they say they’ve paid', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await at(browser, api, users.lead);
  const tom = await at(browser, api, users.tom);

  await tom.getByRole('button', { name: 'Claim Calamari' }).click();
  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  // Running totals: what Tom has, and what it comes to, as he picks.
  const row = lead.locator('.row').filter({ hasText: 'Tom' });
  await expect(row).toContainText('Calamari, Lasagne', POLL);
  await expect(row).toContainText('£39.75');

  // The money lands in the lead's bank before Tom taps I've paid.
  await lead.getByRole('button', { name: 'Tom’s £39.75 received' }).click();
  const sheet = lead.getByRole('dialog', { name: '£39.75 from Tom?' });
  await sheet.getByRole('button', { name: 'Received' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row.getByText('Paid', { exact: true })).toBeVisible();
  await expect(tom.getByRole('heading', { name: 'All square' })).toBeVisible(POLL);
});
