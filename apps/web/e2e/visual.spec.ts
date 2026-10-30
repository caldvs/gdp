/**
 * Screenshot snapshots of the main screens at phone size: a cheap net for
 * the glass kit, where a lot of the look lives in inline styles.
 *
 * Baselines are the CI runner's (Linux Chromium) and live next to this
 * file in visual.spec.ts-snapshots/. To refresh them after a deliberate
 * change, run the "Update visual baselines" workflow and commit what it
 * produces, or locally on Linux: npx playwright test visual --update-snapshots
 */
import { expect, test, type Page } from '@playwright/test';
import { CODE, FakeApi, SID, items, users, type User } from './fakeApi';
import { fragmentFor } from './fakeApi';

// One browser, one size: baselines are per project, and the phone layout
// is the one that matters.
test.beforeEach(({ browserName }, info) => {
  test.skip(info.project.name !== 'desktop' || browserName !== 'chromium', 'snapshots are Chromium-only');
});
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const shot = { maxDiffPixelRatio: 0.01, animations: 'disabled' as const, caret: 'hide' as const };

async function open(page: Page, api: FakeApi, user: User, path: string) {
  await api.attach(page.context(), user);
  await page.goto(path);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

function busyTable() {
  const api = new FakeApi({ serviceRate: 0.125 });
  for (const u of [users.sam, users.priya, users.tom]) api.join(u);
  const [, sam, priya, tom] = api.participants;
  sam!.claimedItemIds = [items[2]!.itemId, items[3]!.itemId];
  sam!.payment = { status: 'pending', paymentId: 'pay-u-sam', payerClaimedPaidAt: '2026-10-31T12:30:00Z' };
  priya!.claimedItemIds = [items[4]!.itemId];
  priya!.payment = { status: 'succeeded', paymentId: 'pay-u-priya', paidAt: '2026-10-31T12:20:00Z' };
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-priya', 'u-tom'], ways: 3, activity: [] });
  priya!.sharedItemIds = [items[1]!.itemId];
  tom!.sharedItemIds = [items[1]!.itemId];
  return api;
}

test('landing', async ({ page }) => {
  await page.route('**/v1/me', (r) => r.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'no' } } }));
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: /Snap the bill/ })).toBeVisible();
  await expect(page).toHaveScreenshot('landing.png', shot);
});

test('invite', async ({ page }) => {
  await page.route('**/v1/me', (r) => r.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'no' } } }));
  await page.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await expect(page.getByText('Callum invited you')).toBeVisible();
  await expect(page).toHaveScreenshot('invite.png', shot);
});

test('camera home', async ({ page }) => {
  const api = new FakeApi();
  await open(page, api, users.lead, '/');
  await expect(page.getByRole('button', { name: 'Take the photo' })).toBeVisible();
  await expect(page).toHaveScreenshot('camera.png', shot);
});

test('check the bill', async ({ page }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  await open(page, api, users.lead, `/confirm-bill/${api.bill.billId}`);
  await expect(page.getByRole('heading', { name: 'Check the bill' })).toBeVisible();
  await expect(page).toHaveScreenshot('check.png', shot);
});

test('the lead’s table', async ({ page }) => {
  const api = busyTable();
  await open(page, api, users.lead, `/session/${SID}`);
  await expect(page.getByText('says they’ve sent it')).toBeVisible();
  await expect(page).toHaveScreenshot('lead-table.png', shot);
});

test('close sheet', async ({ page }) => {
  const api = busyTable();
  await open(page, api, users.lead, `/session/${SID}`);
  await page.getByRole('button', { name: 'Close the bill' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('close-sheet.png', shot);
});

test('guest pick', async ({ page }) => {
  const api = busyTable();
  api.join(users.lead);
  await open(page, api, users.tom, `/session/${SID}`);
  await expect(page.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await expect(page).toHaveScreenshot('pick.png', shot);
});

test('split sheet', async ({ page }) => {
  const api = new FakeApi();
  await open(page, api, users.sam, `/session/${SID}`);
  await page.getByRole('button', { name: 'Split Lasagne' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('split-sheet.png', shot);
});

test('pay', async ({ page }) => {
  const api = new FakeApi();
  await open(page, api, users.sam, `/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await page.getByRole('button', { name: 'Tick Lasagne' }).click();
  await page.getByRole('link', { name: 'Pay Callum £17.25' }).click();
  await expect(page.getByText('gdp-0193ab12')).toBeVisible();
  await expect(page).toHaveScreenshot('pay.png', shot);
});

test('guest table', async ({ page }) => {
  const api = busyTable();
  await open(page, api, users.sam, `/session/${SID}`);
  await expect(page.getByText('Waiting for Callum to close the bill')).toBeVisible();
  await expect(page).toHaveScreenshot('guest-table.png', shot);
});

test('settled', async ({ page }) => {
  const api = busyTable();
  api.status = 'settled';
  await open(page, api, users.lead, `/session/${SID}`);
  await expect(page.getByText('back in your account')).toBeVisible();
  await expect(page).toHaveScreenshot('settled.png', shot);
});
