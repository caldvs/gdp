/**
 * #219/#220: the links in guests' texts, and the receipt by email. The bill
 * page (G5) is read-only, works without signing in, and never shows bank
 * details: a guest who owes is sent to the pay page only on a device that
 * has the lead's details from the QR.
 */
import { expect, test, type Browser } from '@playwright/test';
import { CODE, FakeApi, LINK_TOKEN, SID, LEAD_BANK, fragmentFor, items, users, type User } from './fakeApi';

const POLL = { timeout: 15_000 };

async function open(browser: Browser, api: FakeApi, user: User, to: string, opts: { signedIn?: boolean } = {}) {
  const ctx = await browser.newContext();
  await api.attach(ctx, user, { atTable: false, ...opts });
  const page = await ctx.newPage();
  await page.goto(to);
  return page;
}

function samOwes(api: FakeApi) {
  api.join(users.sam);
  api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds = [items[2]!.itemId];
}

test('#220 G5: the bill from a text, signed out: who had what, Sam marked, no bank details', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  const page = await open(browser, api, users.sam, `/b/${LINK_TOKEN}`, { signedIn: false });
  await expect(page).toHaveURL(new RegExp(`/b/${LINK_TOKEN}$`));
  await expect(page.getByRole('heading', { name: 'Gennaro' })).toBeVisible(POLL);
  const you = page.getByRole('table', { name: 'You' });
  await expect(you).toContainText('Sam Patel (you)');
  await expect(you).toContainText('Not paid');
  await expect(page.getByRole('table', { name: 'Callum Davies' })).toContainText('Callum’s share');
  // Nowhere to pay from here: no details on this device.
  await expect(page.getByText('You owe Callum £17.25')).toBeVisible();
  await expect(page.getByText('Pay Callum directly. Callum marks it received.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pay Callum' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(LEAD_BANK.sortCode);
  await expect(page.locator('body')).not.toContainText(LEAD_BANK.accountNumber);
  await expect(page.getByText(/This link works until/)).toBeVisible();
});

test('#219: on the phone that scanned the QR, the bill page sends Sam to pay', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam);
  const sam = await ctx.newPage();
  // The QR put the lead's details on this phone.
  await sam.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await expect(sam).toHaveURL(new RegExp(`/session/${SID}`), POLL);
  await sam.goto(`/b/${LINK_TOKEN}`);
  await expect(sam.getByText('You owe Callum £17.25')).toBeVisible(POLL);
  await sam.getByRole('link', { name: 'Pay Callum' }).click();
  await expect(sam).toHaveURL(new RegExp(`/session/${SID}/pay`));
  await expect(sam.getByText('Gennaro Sam')).toBeVisible(POLL);
});

test('#220 G5: once received, it says so', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  api.respond({ method: 'POST', path: `/v1/sessions/${SID}/participants/u-sam/received`, body: null }, users.lead);
  const page = await open(browser, api, users.sam, `/b/${LINK_TOKEN}`, { signedIn: false });
  await expect(page.getByText('Callum got your £17.25')).toBeVisible(POLL);
  await expect(page.getByRole('table', { name: 'You' })).toContainText('Paid');
});

test('#220: a link past its month says it has gone', async ({ browser }) => {
  const api = new FakeApi();
  const page = await open(browser, api, users.sam, '/b/ZZZZZZZZZZZZZZZZ', { signedIn: false });
  await expect(page.getByText('This link has expired.')).toBeVisible(POLL);
  await expect(page.getByText('Bill links work for 30 days.')).toBeVisible();
});

test('#220 G4.3: All square offers the receipt by email', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  api.respond({ method: 'POST', path: `/v1/sessions/${SID}/participants/u-sam/received`, body: null }, users.lead);
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam);
  const sam = await ctx.newPage();
  await sam.goto(`/session/${SID}`);
  await expect(sam.getByRole('heading', { name: 'All square' })).toBeVisible(POLL);
  const field = sam.getByLabel('Email me the receipt');
  await field.fill('nope');
  await sam.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByRole('alert').filter({ hasText: 'That doesn’t look like an email address.' })).toBeVisible();
  await field.fill('Sam@Example.com');
  await sam.getByRole('button', { name: 'Send' }).click();
  await expect(sam.getByRole('status').filter({ hasText: 'Receipt sent to Sam@Example.com.' })).toBeVisible();
  expect(api.receipts).toEqual([{ userId: 'u-sam', email: 'sam@example.com' }]);
});

test('#219: the lead taps Remind on Sam: one text, then Reminded today', async ({ browser }) => {
  const api = new FakeApi();
  api.textsOn = true;
  samOwes(api);
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  const lead = await ctx.newPage();
  await lead.goto(`/session/${SID}`);
  await lead.getByRole('button', { name: 'Remind Sam' }).click();
  await expect(lead.getByText('Reminded today')).toBeVisible(POLL);
  await expect(lead.getByRole('button', { name: 'Remind Sam' })).toHaveCount(0);
  expect(api.texts).toEqual([{ userId: 'u-sam', kind: 'reminder' }]);
});

test('#219: no Remind where texts are off', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  const lead = await ctx.newPage();
  await lead.goto(`/session/${SID}`);
  await expect(lead.getByRole('button', { name: 'Sam’s £17.25 received' })).toBeVisible(POLL);
  await expect(lead.getByRole('button', { name: 'Remind Sam' })).toHaveCount(0);
});

test('#219: Stop reminders from the text, signed out', async ({ browser }) => {
  const api = new FakeApi();
  samOwes(api);
  const page = await open(browser, api, users.sam, `/s/${LINK_TOKEN}`, { signedIn: false });
  await expect(page.getByText('No more reminders for this bill.')).toBeVisible(POLL);
  expect(api.stopped).toEqual(['u-sam']);
  await page.getByRole('link', { name: 'See the bill' }).click();
  await expect(page.getByRole('table', { name: 'You' })).toBeVisible(POLL);
});
