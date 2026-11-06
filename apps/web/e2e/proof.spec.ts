/**
 * #226: a guest still waiting 30s after *I've paid* can send the lead a
 * cropped screenshot of the payment; the lead sees it on the bill.
 */
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, users, type User } from './fakeApi';

const POLL = { timeout: 15_000 };
const SHOT = path.join(__dirname, 'fixtures', 'bill.jpg');

async function at(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

test('waiting: crop and send a screenshot; the lead sees it; the guest can remove it', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await at(browser, api, users.lead);
  const sam = await at(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam).toHaveURL(new RegExp(`/session/${SID}$`), POLL);
  await expect(sam.getByText('Waiting for Callum to mark it received')).toBeVisible(POLL);
  // Not straight away: only once it's been 30 seconds.
  await expect(sam.getByRole('heading', { name: 'Proof of payment' })).toHaveCount(0);

  // 30 seconds on, by the server's clock: a reload doesn't restart it.
  const entry = api.participants.find((p) => p.userId === 'u-sam')!.payments!.at(-1)!;
  entry.payerClaimedPaidAt = new Date(Date.now() - 31_000).toISOString();
  await sam.reload();
  await expect(sam.getByRole('heading', { name: 'Proof of payment' })).toBeVisible(POLL);
  await expect(sam.getByText('Bank transfers can take a while.', { exact: false })).toBeVisible();

  await sam.getByLabel('Choose a screenshot').setInputFiles(SHOT);
  await expect(sam.getByText('Crop out your balance and account numbers.', { exact: false })).toBeVisible();
  // The main action while cropping; the page's own buttons step aside.
  await expect(sam.getByRole('link', { name: 'See Callum’s bank details' })).toHaveCount(0);
  const frame = sam.getByTestId('crop-frame');
  const before = (await frame.boundingBox())!;
  await sam.getByRole('button', { name: /^Bottom-right corner/ }).press('ArrowDown');
  await sam.getByRole('button', { name: /^Bottom-right corner/ }).press('ArrowDown');
  expect((await frame.boundingBox())!.height).toBeGreaterThan(before.height);

  await sam.getByRole('button', { name: 'Send to Callum' }).click();
  await expect(sam.getByText('Sent to Callum.')).toBeVisible();
  await expect(sam.getByText('Only Callum sees it.', { exact: false })).toBeVisible();
  expect(api.proofUploads).toBe(1);
  const put = api.requests.find((r) => r.method === 'POST' && r.path === `/v1/sessions/${SID}/proofs`)!;
  expect(JSON.parse(put.body!).sizeBytes).toBeLessThanOrEqual(2 * 1024 * 1024);

  // The lead: the row says so, and the screenshot opens. Still not payment.
  await expect(lead.getByText('Sent a screenshot', { exact: false })).toBeVisible(POLL);
  await lead.getByRole('button', { name: 'See screenshot' }).click();
  const dialog = lead.getByRole('dialog', { name: 'Sam’s screenshot' });
  await expect(dialog.getByRole('img', { name: 'Their payment screenshot' })).toBeVisible();
  await expect(dialog).toContainText('A screenshot isn’t payment.');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await sam.getByRole('button', { name: 'Remove' }).click();
  await expect(sam.getByRole('button', { name: 'Attach a screenshot' })).toBeVisible();
  expect(api.proofs).toHaveLength(0);
});
