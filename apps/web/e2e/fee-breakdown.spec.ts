/**
 * #217 L8: the platform fee on a settled bill, and how it was worked out
 * (#228: the hold is released, the saved card charged the round-ups). L8.1
 * guests still owing; L8.2 nobody joined; a free credit.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BID, FakeApi, SID, items, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  return ctx.newPage();
}

const hold = (over: Record<string, unknown> = {}) => ({
  billId: BID, sessionId: SID, amountPence: 100, paidAt: '2026-10-31T19:00:00.000Z', kind: 'hold', savedCard: true,
  releasedAt: '2026-10-31T23:00:00.000Z', ...over,
});
const billing = (fees: Record<string, unknown>[], credits: Record<string, unknown>[] = []) => ({
  creditsLeft: 0 as const, nextCreditOn: '2026-12-01', paidPence: 0, refundedPence: 0,
  card: { brand: 'visa', last4: '4417' }, fees, credits,
});

/** Sam had the Lasagne (£17.25 → £18.00, 75p) and paid; Tom the Calamari (£22.50 → £23.00, 50p). */
function table(api: FakeApi, tomPaid: boolean) {
  api.join(users.sam);
  api.join(users.tom);
  const [, sam, tom] = api.participants;
  sam!.claimedItemIds = [items[2]!.itemId];
  sam!.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T21:30:00Z' };
  tom!.claimedItemIds = [items[1]!.itemId];
  if (tomPaid) tom!.payment = { status: 'succeeded', paymentId: 'pay-u-tom', paidAt: '2026-10-31T21:40:00Z' };
}

test('L8: charged to your card, the hold released, and how: each guest’s round-up, you paid £0.00', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100, status: 'settled' });
  table(api, true);
  api.billing = billing([hold({ chargeStatus: 'charged', chargePence: 125 })]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}`);
  await lead.getByRole('link', { name: 'Platform fee' }).click();

  await expect(lead).toHaveURL(new RegExp(`/session/${SID}/fee$`));
  await expect(lead.getByRole('heading', { name: 'Platform fee' })).toBeVisible();
  await expect(lead.getByTestId('fee-headline')).toHaveText('£1.25 charged to your card');
  await expect(lead.getByText('Your £1.00 hold is released')).toBeVisible();
  const t = lead.getByRole('table', { name: 'Round-ups' });
  await expect(t.getByRole('row', { name: /Sam/ })).toHaveText(/Sam£17\.25£18\.00£0\.75/);
  await expect(t.getByRole('row', { name: /Tom/ })).toHaveText(/Tom£22\.50£23\.00£0\.50/);
  await expect(t.getByRole('row', { name: /Round-ups you got/ })).toContainText('£1.25');
  await expect(t.getByRole('row', { name: /^Platform fee/ })).toContainText('£1.25');
  await expect(t.getByRole('row', { name: /You paid towards it/ })).toContainText('£0.00');
  await expect(lead.getByText('Visa ending 4417 · On your statement as PAYMEBACK.DEV')).toBeVisible();
  await expect(lead.getByText(/pays? later/)).toHaveCount(0);
});

test('L8.1: a guest still owing doesn’t count; what they pay later is all yours', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100, status: 'settled' });
  table(api, false);
  api.billing = billing([hold({ chargeStatus: 'charged', chargePence: 75 })]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}/fee`);
  await expect(lead.getByTestId('fee-headline')).toHaveText('£0.75 charged to your card');
  const t = lead.getByRole('table', { name: 'Round-ups' });
  await expect(t.getByRole('row', { name: /Tom/ })).toContainText('Not yet');
  await expect(t.getByRole('row', { name: /Round-ups you got/ })).toContainText('£0.75');
  await expect(lead.getByText('If Tom pays later, the money is all yours. Nothing more is charged.')).toBeVisible();
});

test('the bank wants it confirmed: a button to confirm it', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100, status: 'settled' });
  table(api, true);
  api.billing = billing([hold({ chargeStatus: 'needs_confirming', chargePence: 125 })]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}/fee`);
  await expect(lead.getByTestId('fee-headline')).toHaveText('£1.25 to confirm');
  await expect(lead.getByRole('link', { name: 'Confirm £1.25' })).toHaveAttribute('href', `/fee-charge/${BID}`);
});

test('L8.2: nobody joined, so the hold is released and there’s no fee', async ({ browser }) => {
  const api = new FakeApi({ platformFeePence: 100, status: 'settled' });
  api.billing = billing([hold()]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}/fee`);
  await expect(lead.getByText('Your £1.00 hold is released')).toBeVisible();
  await expect(lead.getByText('Nobody joined, so there’s no fee.')).toBeVisible();
  await expect(lead.getByRole('table')).toHaveCount(0);
});

test('a free credit: just that, no hold', async ({ browser }) => {
  const api = new FakeApi({ status: 'settled' });
  table(api, true);
  api.billing = billing([], [{ month: '2026-10', billId: BID, sessionId: SID, claimedAt: '2026-10-31T19:00:00.000Z' }]);
  const lead = await diner(browser, api, users.lead);
  await lead.goto(`/session/${SID}/fee`);
  await expect(lead.getByText('Free credit', { exact: true })).toBeVisible();
  await expect(lead.getByText(/hold/)).toHaveCount(0);
});
