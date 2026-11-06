/**
 * A discount that isn't one item's (Callum, 8 Nov 2026): a line of its own
 * under the items, which keep their printed prices, shared by what each
 * person had, like service but taken off.
 */
import { expect, test } from '@playwright/test';
import { CODE, FakeApi, fragmentFor, item, users } from './fakeApi';

const POLL = { timeout: 15_000 };
const holland = () =>
  new FakeApi({
    items: [item(1, 'Roast Beef', 2600, 2), item(2, 'Diet Coke', 375)],
    serviceRate: 0.125,
    discounts: [{ name: 'Fork Loyalty Discount', amountPence: 5000 }],
  });

test('Check it matches shows the discount under the items, and the lead can change it', async ({ browser }) => {
  const api = holland();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  const lead = await ctx.newPage();
  await lead.goto(`/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Check it matches' })).toBeVisible();
  const receipt = lead.locator('.receipt');
  // Items at their printed prices; service as a share of them.
  await expect(receipt).toContainText('2 × Roast Beef52.00');
  await expect(receipt).toContainText('Service 12.5%6.97');
  await expect(receipt).toContainText('Fork Loyalty Discount−50.00');
  await expect(lead.getByTestId('bill-total')).toHaveText('£12.72');
  await expect(lead.getByText('Adds up to the receipt')).toBeVisible();

  await lead.getByRole('button', { name: 'Edit Fork Loyalty Discount' }).click();
  await lead.getByLabel('Fork Loyalty Discount').fill('40.00');
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByTestId('bill-total')).toHaveText('£22.72');
  await expect.poll(() => api.discounts).toEqual([{ name: 'Fork Loyalty Discount', amountPence: 4000 }]);
});

test('a guest’s share shows their part of the discount, and adds up', async ({ browser }) => {
  const api = holland();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { atTable: false });
  const sam = await ctx.newPage();
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies' })}`);
  await sam.getByRole('button', { name: 'Claim Diet Coke' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();

  await expect(sam.getByRole('heading', { name: 'Pay Callum' })).toBeVisible();
  const share = sam.getByRole('region', { name: 'Your share' });
  // 3.75 of 55.75 in items: 375 × 12.72 / 55.75 = 85.6p, rounded down to 0.85;
  // 3.37 of the £50 off (rounded up for showing), and service to match.
  await expect(share).toContainText('Diet Coke3.75');
  await expect(share).toContainText('Service0.47');
  await expect(share).toContainText('Discount−3.37');
  await expect(share).toContainText('You pay Callum£0.85');
});
