/**
 * #166: when the lead shared on a £1 hold, each guest pays part of it back
 * with their bill, in proportion to what they ordered: floor(£1 × their
 * items ÷ the bill's items). It doesn't depend on who joins or pays first.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

const POLL = { timeout: 10_000 };

async function at(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

test('guests pay their part of the £1 hold with their bill, by what they ordered', async ({ browser }) => {
  // Items come to £104.00. Lasagne £17.25 → 16p of the £1; Calamari £22.50 → 21p.
  const api = new FakeApi({ platformFeePence: 100 });
  const lead = await at(browser, api, users.lead);
  const sam = await at(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByText('Your total incl. fee')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£17.41');

  // Tom joining and claiming doesn't change Sam's part.
  const tom = await at(browser, api, users.tom);
  await tom.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£22.71');
  await expect(sam.getByTestId('your-share')).toHaveText('£17.41');

  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.locator('.pay-total')).toHaveText('You pay Callum£17.41');
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('dialog', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('You’ve sent £17.41.')).toBeVisible(POLL);
  await expect(sam.getByText('Platform fee')).toBeVisible();
  await expect(sam.getByText('£0.16')).toBeVisible();

  await expect(lead.getByText('Says they’ve paid £17.41')).toBeVisible(POLL);
});

test('with no hold (a credit, or Stripe off) guests pay just their bill', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await at(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£17.25');
  await expect(sam.getByText('Your total incl. fee')).toHaveCount(0);
});
