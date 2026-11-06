/**
 * #222: paying the lead. G3 shows the guest's share as a receipt, Monzo and
 * Revolut when the lead saved them, then bank details with a readable
 * reference. *I've paid* confirms in place; G4 waits for the lead and flips
 * to *All square* (G4.3) when they mark it received.
 */
import { expect, test } from '@playwright/test';
import { CODE, FakeApi, SID, fragmentFor, users } from './fakeApi';

const POLL = { timeout: 15_000 };

test('a guest pays with the Monzo link, confirms, waits, and is all square once the lead marks it received', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { atTable: false });
  const sam = await ctx.newPage();
  await sam.goto(`/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await sam.getByRole('button', { name: 'Claim Calamari' }).click(POLL);
  await sam.getByRole('link', { name: 'Continue to payment' }).click();

  // G3: the share as a receipt, the apps, then bank transfer.
  await expect(sam.getByRole('heading', { name: 'Pay Callum' })).toBeVisible();
  const share = sam.getByRole('region', { name: 'Your share' });
  await expect(share).toContainText('Calamari22.50');
  await expect(share).toContainText('You pay Callum£22.50');
  await expect(sam.getByRole('link', { name: 'Pay with Monzo' })).toHaveAttribute('href', 'https://monzo.me/callum.davies/22.50?d=Gennaro%20Sam');
  await expect(sam.getByText('Amount and reference filled in.')).toBeVisible();
  await expect(sam.getByText('Opens Revolut. Enter £22.50.')).toBeVisible();
  await expect(sam.getByRole('heading', { name: 'Or pay by bank transfer' })).toBeVisible();
  await expect(sam.getByText('Gennaro Sam')).toBeVisible();

  // I've paid confirms in place, and Not yet puts it away.
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  const ask = sam.getByRole('group', { name: 'Are you sure you’ve paid?' });
  await expect(ask).toBeFocused();
  await expect(ask).toHaveAccessibleDescription('Only once it’s left your account. Callum checks it’s landed.');
  await expect(sam.getByRole('dialog')).toHaveCount(0);
  await ask.getByRole('button', { name: 'Not yet' }).click();
  await expect(ask).toHaveCount(0);
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await ask.getByRole('button', { name: 'Yes, I’ve paid' }).click();

  // G4: waiting, with SENT on the receipt.
  await expect(sam.getByRole('heading', { name: 'Waiting for Callum' })).toBeVisible(POLL);
  await expect(sam.getByText('You’ve sent £22.50.')).toBeVisible();
  await expect(share).toContainText('Sent to Callum£22.50');
  await expect(share).toContainText('SENT');
  await expect(sam.getByRole('status').filter({ hasText: 'Waiting for Callum to mark it received' })).toBeVisible();

  // The lead marks it received; Sam's page flips on its next poll.
  const lctx = await browser.newContext();
  await api.attach(lctx, users.lead);
  const lead = await lctx.newPage();
  await lead.goto(`/session/${SID}`);
  await lead.getByRole('button', { name: 'Sam’s £22.50 received' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();

  await expect(sam.getByRole('heading', { name: 'All square' })).toBeVisible(POLL);
  await expect(sam.getByText('Callum got your £22.50. Nothing more to do.')).toBeVisible();
  await expect(share).toContainText('Paid to Callum£22.50');
  await expect(share).toContainText('PAID');
});
