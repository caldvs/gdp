/**
 * After the lead closes the bill: guests who still owe can pay, someone
 * already at the table can reopen the link, and a newcomer is told it's
 * closed instead of being let in.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { CODE, FakeApi, SID, fragmentFor, items, users, type User } from './fakeApi';

// Another page's change arrives on its next poll (every 5s while claiming):
// allow three, for a busy CI runner with several WebKit pages open.
const POLL = { timeout: 15_000 };

async function open(browser: Browser, api: FakeApi, user: User, to: string, atTable = true): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user, { atTable });
  const page = await ctx.newPage();
  await page.goto(to);
  return page;
}

test('a guest who still owes pays after the lead closes; the lead sees it come in', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.participants[1]!.claimedItemIds = [items[2]!.itemId];
  const lead = await open(browser, api, users.lead, `/session/${SID}`);
  await lead.getByRole('button', { name: 'Mark as settled' }).click();
  await lead.getByRole('group', { name: 'Mark the bill as settled?' }).getByRole('button', { name: 'Mark as settled' }).click();
  await expect(lead.getByText('Settled', { exact: true })).toBeVisible(POLL);

  // Sam reopens the link from the group chat: straight back to the table, not an error.
  const sam = await open(browser, api, users.sam, `/join/${CODE}#p=${fragmentFor()}`);
  await expect(sam).toHaveURL(new RegExp(`/session/${SID}`), POLL);
  await expect(sam.getByText('Settled', { exact: true })).toBeVisible(POLL);
  await expect(sam.getByText('You owe Callum £17.25')).toBeVisible();
  await sam.getByRole('link', { name: 'Pay Callum £17.25' }).click();
  await expect(sam.getByText('Gennaro Sam')).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('Waiting for Callum to mark it received')).toBeVisible(POLL);

  // The closed bill isn't polled; the lead comes back to it and marks it received.
  await lead.reload();
  await expect(lead.getByText(/^Says they’ve paid £17\.25/)).toBeVisible(POLL);
  await lead.getByRole('button', { name: 'Sam’s £17.25 received' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Received' }).click();
  await expect(lead.getByText('Everyone’s paid')).toBeVisible(POLL);
  await expect(lead.locator('.totals__line', { hasText: 'Back from friends' })).toContainText('Sam £17.25');
});

test('a newcomer opening the link after the bill is closed is told so, and not seated', async ({ browser }) => {
  const api = new FakeApi();
  api.status = 'settled';
  const tom = await open(browser, api, users.tom, `/join/${CODE}#p=${fragmentFor()}`, false);
  await expect(tom.getByRole('heading', { name: 'Couldn’t join' })).toBeVisible(POLL);
  await expect(tom.getByText('This bill’s already settled.')).toBeVisible();
  expect(api.participants.some((p) => p.userId === users.tom.userId)).toBe(false);
});
