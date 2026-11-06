/**
 * #228: the £1 hold saves the lead's card. At settle the hold is released
 * and the card is charged the guests' round-ups; Account shows the card with
 * Remove; a charge the bank wants confirmed links to its page.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BID, FakeApi, SID, items, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  return ctx.newPage();
}

const hold = (over: Record<string, unknown> = {}) => ({
  billId: BID,
  sessionId: SID,
  amountPence: 100,
  paidAt: '2026-10-31T19:00:00.000Z',
  kind: 'hold',
  savedCard: true,
  ...over,
});
const billing = (fees: Record<string, unknown>[], card = true) => ({
  creditsLeft: 0 as const,
  nextCreditOn: '2026-12-01',
  paidPence: 0,
  refundedPence: 0,
  ...(card ? { card: { brand: 'visa', last4: '4417' } } : {}),
  fees,
  credits: [],
});

test('Account shows the saved card, and Remove forgets it', async ({ browser }) => {
  const api = new FakeApi();
  api.billing = billing([]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto('/account');
  const row = lead.getByRole('button', { name: 'Remove Visa ending 4417' });
  await expect(row).toContainText('Visa ending 4417 · For the platform fee');
  await row.click();
  await expect(row).toHaveCount(0);
});

test('settling on a hold that saved the card: charged to your card, the hold released', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100 });
  api.billing = billing([hold()]);
  api.join(users.sam);
  const sam = api.participants[1]!;
  // Lasagne £17.25 → £18.00: a 75p round-up, confirmed by the lead.
  sam.claimedItemIds = [items[2]!.itemId];
  sam.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T12:30:00Z' };
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}`);

  await lead.getByRole('button', { name: 'Mark as settled' }).click();
  const ask = lead.getByRole('group', { name: 'Mark the bill as settled?' });
  await expect(ask).toContainText('Platform fee · charged to your card£0.75');
  await expect(ask).toContainText('Your £1.00 hold is released.');
});

test('the settled bill: the charge, or a link to confirm it', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100, status: 'settled' });
  api.billing = billing([hold({ releasedAt: '2026-11-01T10:00:00Z', chargeStatus: 'charged', chargePence: 184 })]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}`);
  const line = lead.locator('.totals__line', { hasText: 'Platform fee' });
  await expect(line).toContainText('Charged to your card · hold released');
  await expect(line).toContainText('£1.84');

  api.billing = billing([hold({ releasedAt: '2026-11-01T10:00:00Z', chargeStatus: 'needs_confirming', chargePence: 184 })]);
  api.feeCharge = { billId: BID, status: 'needs_confirming', amountPence: 184, clientSecret: 'pi_x_secret_y', paymentMethodId: 'pm_visa', card: { brand: 'visa', last4: '4417' } };
  await lead.reload();
  await lead.getByRole('link', { name: 'Confirm the charge' }).click();
  await expect(lead).toHaveURL(new RegExp(`/fee-charge/${BID}$`));
  await expect(lead.getByRole('heading', { name: 'Confirm the platform fee' })).toBeVisible();
  await expect(lead.locator('.row', { hasText: 'Platform fee' })).toContainText('£1.84');
});
