/**
 * Accessibility: axe on each main screen. Fails on serious and critical
 * violations (WCAG 2.1 A and AA), and on any structure finding (landmarks,
 * headings, lists) whatever its impact. Every screen has its own title.
 * Chromium only; one size.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { CODE, FakeApi, SID, fragmentFor, items, users, type User } from './fakeApi';

test.beforeEach(({ browserName }, info) => {
  test.skip(info.project.name !== 'desktop' || browserName !== 'chromium', 'one browser is enough for axe');
});
// Reduced motion: axe otherwise catches avatars mid fade-in and reports low contrast.
test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

async function open(page: Page, api: FakeApi, user: User | null, to: string) {
  if (user) await api.attach(page.context(), user);
  else await page.route('**/v1/me', (r) => r.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'no' } } }));
  // #183: the QR's landing page shows the bill before anyone signs in.
  if (!user) await page.route('**/v1/sessions/preview', (r) => r.fulfill({ status: 200, json: { sessionId: SID, status: 'claiming', hostName: 'Callum', venueName: 'Gennaro', createdAt: '2026-10-31T12:00:00Z', itemCount: 8, totalPence: 13129, people: ['Callum', 'Priya', 'Sam'] } }));
  await page.goto(to);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/**
 * Findings to tolerate, by rule and the start of the element's selector.
 * Empty: fix new findings rather than listing them.
 */
const KNOWN: { rule: string; target: RegExp; why: string }[] = [];

/** The page's structure (#186–#191): these fail at any impact. */
const STRUCTURE = new Set([
  'region', 'landmark-one-main', 'landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo', 'landmark-no-duplicate-main', 'landmark-unique',
  'page-has-heading-one', 'heading-order', 'empty-heading', 'list', 'listitem', 'definition-list', 'dlitem', 'aria-valid-attr-value',
]);

async function audit(page: Page) {
  // Check the settled screen, not a sheet halfway through fading in.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .exclude('nextjs-portal')
    .analyze();
  const bad = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || STRUCTURE.has(v.id))
    .flatMap((v) =>
      v.nodes
        .map((n) => n.target.join(' '))
        .filter((t) => !KNOWN.some((k) => k.rule === v.id && k.target.test(t)))
        .map((t) => `${v.id} (${v.impact}): ${v.help} — ${t}`),
    );
  expect(bad).toEqual([]);
  // The front door keeps the site's name; every other screen says where you are.
  if (new URL(page.url()).pathname !== '/sign-in') await expect(page).toHaveTitle(/^.+ · Pay Me Back$/);
}

function busyTable() {
  const api = new FakeApi({ serviceRate: 0.125 });
  for (const u of [users.sam, users.priya, users.tom]) api.join(u);
  const [, sam, priya, tom] = api.participants;
  sam!.claimedItemIds = [items[2]!.itemId];
  sam!.payment = { status: 'pending', paymentId: 'pay-u-sam', payerClaimedPaidAt: '2026-10-31T12:30:00Z' };
  priya!.claimedItemIds = [items[4]!.itemId];
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-priya', 'u-tom'], ways: 3, activity: [] });
  priya!.sharedItemIds = [items[1]!.itemId];
  tom!.sharedItemIds = [items[1]!.itemId];
  return api;
}

test('landing', async ({ page }) => {
  await open(page, new FakeApi(), null, '/sign-in');
  await expect(page.getByRole('heading', { name: /Pay the bill/ })).toBeVisible();
  await audit(page);
});

test('invite', async ({ page }) => {
  await open(page, new FakeApi(), null, `/join/${CODE}#p=${fragmentFor()}`);
  await expect(page.getByRole('heading', { name: 'Join Callum’s bill' })).toBeVisible();
  await audit(page);
});

test('bills home', async ({ page }) => {
  await open(page, new FakeApi(), users.lead, '/');
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await audit(page);
});

test('review the bill', async ({ page }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  await open(page, api, users.lead, `/confirm-bill/${api.bill.billId}`);
  await expect(page.getByRole('heading', { name: 'Check it matches' })).toBeVisible();
  await audit(page);
});

test('bank details', async ({ page }) => {
  await open(page, new FakeApi(), users.lead, '/payout-account');
  await expect(page.getByLabel('Sort code')).toBeVisible();
  await audit(page);
});

test('the lead’s bill and Mark as settled', async ({ page }) => {
  await open(page, busyTable(), users.lead, `/session/${SID}`);
  await expect(page.getByText(/^Says they’ve paid/)).toBeVisible();
  await expect(page.locator('[data-row][data-group="others"]').first()).toBeVisible();
  await audit(page);
  await page.getByRole('button', { name: 'Mark as settled' }).click();
  await expect(page.getByRole('group', { name: 'Mark the bill as settled?' })).toBeVisible();
  await audit(page);
});

test('the whole bill', async ({ page }) => {
  await open(page, busyTable(), users.lead, `/session/${SID}`);
  await page.getByRole('link', { name: 'The whole bill' }).click();
  await expect(page.getByRole('heading', { name: /The whole bill/ })).toBeVisible();
  await audit(page);
});

test('splitting someone else’s dish', async ({ page }) => {
  const api = new FakeApi();
  api.join(users.priya);
  api.participants[1]!.claimedItemIds = [items[2]!.itemId];
  await open(page, api, users.tom, `/session/${SID}`);
  await page.getByRole('button', { name: 'More for Lasagne' }).click();
  await expect(page.getByRole('group', { name: 'Split Lasagne' })).toBeVisible();
  await audit(page);
});

test('guest pick', async ({ page }) => {
  const api = new FakeApi();
  await open(page, api, users.sam, `/session/${SID}`);
  await expect(page.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await audit(page);
});

test('pay', async ({ page }) => {
  await open(page, new FakeApi(), users.sam, `/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await page.getByRole('button', { name: 'Claim Lasagne' }).click();
  await page.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(page.getByText('Gennaro Sam')).toBeVisible();
  await audit(page);
});

test('closed bill', async ({ page }) => {
  const api = busyTable();
  api.status = 'settled';
  await open(page, api, users.lead, `/session/${SID}`);
  await expect(page.getByText('Settled', { exact: true })).toBeVisible();
  await audit(page);
});
