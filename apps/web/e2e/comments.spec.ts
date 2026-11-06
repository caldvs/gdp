/**
 * #218: each bill has a comments thread. Sam writes "Sent mine by Monzo"
 * on the waiting screen; Callum sees it on the bill within a poll.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

const POLL = { timeout: 15_000 };

async function at(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

test('Sam comments while waiting; Callum sees it on the bill and replies', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await at(browser, api, users.lead);
  const sam = await at(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('Waiting for Callum to mark it received')).toBeVisible(POLL);

  await sam.getByLabel('Write a comment').fill('Sent mine by Monzo');
  await sam.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByRole('list', { name: 'Comments' })).toContainText('Sent mine by Monzo');
  await expect(sam.getByLabel('Write a comment')).toHaveValue('');

  const thread = lead.getByRole('list', { name: 'Comments' });
  await expect(thread).toContainText('Sam', POLL);
  await expect(thread).toContainText('Sent mine by Monzo');

  await lead.getByLabel('Write a comment').fill('Got it <b>thanks</b> https://example.com');
  await lead.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByRole('list', { name: 'Comments' })).toContainText('Got it <b>thanks</b> https://example.com', POLL);
  // Text only: no links, no markup.
  await expect(sam.getByRole('list', { name: 'Comments' }).getByRole('link')).toHaveCount(0);
});
