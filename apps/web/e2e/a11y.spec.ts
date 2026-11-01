/**
 * Accessibility: axe on each main screen. Fails on serious and critical
 * violations (WCAG 2.1 A and AA). Chromium only; one size.
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
  await page.goto(to);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/**
 * Findings that were already there when this check was added (1 Nov 2026),
 * by rule and the start of the element's selector. New ones fail. Fixing
 * these changes visual baselines or e2e selectors, so each fix removes its
 * entry in the same PR.
 */
const KNOWN: { rule: string; target: RegExp; why: string }[] = [
  { rule: 'color-contrast', target: /^\.pick--taken/, why: 'lines someone else took are greyed below 4.5:1' },
  { rule: 'label-content-name-mismatch', target: /^button\[aria-label="Copy /, why: 'copy buttons show the value, are named "Copy …"' },
  { rule: 'label-content-name-mismatch', target: /^button\[aria-label="Edit /, why: 'Review bill rows show name and price, are named "Edit …"' },
  { rule: 'label-content-name-mismatch', target: /^button\[aria-label="(Hand back|Join the split for|Take|Take one|Tick|Untick|Split|Leave the split for) /, why: 'pick rows are named by action, not the visible text' },
  { rule: 'link-in-text-block', target: /^a\[href\$="join"\]/, why: 'the "join" link on the landing page is colour-only' },
];

async function audit(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('nextjs-portal')
    .analyze();
  const bad = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes
        .map((n) => n.target.join(' '))
        .filter((t) => !KNOWN.some((k) => k.rule === v.id && k.target.test(t)))
        .map((t) => `${v.id} (${v.impact}): ${v.help} — ${t}`),
    );
  expect(bad).toEqual([]);
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
  await expect(page.getByRole('heading', { name: 'Split the bill, get paid back' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await audit(page);
});

test('bank details', async ({ page }) => {
  await open(page, new FakeApi(), users.lead, '/payout-account');
  await expect(page.getByLabel('Sort code')).toBeVisible();
  await audit(page);
});

test('the lead’s table and the close dialog', async ({ page }) => {
  await open(page, busyTable(), users.lead, `/session/${SID}`);
  await expect(page.getByText('Says they’ve paid')).toBeVisible();
  await audit(page);
  await page.getByRole('button', { name: 'Close bill' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page);
});

test('guest pick and the split dialog', async ({ page }) => {
  const api = new FakeApi();
  await open(page, api, users.sam, `/session/${SID}`);
  await expect(page.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await audit(page);
  await page.getByRole('button', { name: 'Split Lasagne' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page);
});

test('pay', async ({ page }) => {
  await open(page, new FakeApi(), users.sam, `/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
  await page.getByRole('button', { name: 'Tick Lasagne' }).click();
  await page.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(page.getByText('gdp-0193ab12')).toBeVisible();
  await audit(page);
});

test('closed bill', async ({ page }) => {
  const api = busyTable();
  api.status = 'settled';
  await open(page, api, users.lead, `/session/${SID}`);
  await expect(page.getByText('Bill closed')).toBeVisible();
  await audit(page);
});
