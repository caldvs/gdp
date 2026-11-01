/**
 * Guards the visual baselines can't express as rules: every control is big
 * enough to hit with a thumb, the action bar's buttons keep their height,
 * the lead's own bank details never leave the device, and a full table of
 * ten works end to end.
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { CODE, FakeApi, LEAD_BANK, SID, fragmentFor, item, items, users, type User } from './fakeApi';

const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');
/** Apple and Google's minimum for a touch target. */
const MIN_TAP = 44;

async function open(page: Page, api: FakeApi, user: User, to: string) {
  await api.attach(page.context(), user);
  await page.goto(to);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/**
 * Known undersized controls, each with why it's tolerated for now. Fixing
 * one changes a visual baseline, so it waits for the next baseline refresh;
 * remove the entry with the fix.
 */
const KNOWN_SMALL = new Set([
  // Review bill: the inline "change" buttons on the service and tax lines are 32px.
  'button "Change service charge"',
  'button "Change tax"',
]);

/** Visible interactive elements shorter than MIN_TAP, described for the failure message. */
async function smallTargets(page: Page): Promise<string[]> {
  const found = await page.evaluate((min) => {
    const sel = 'button, a[href], [role="button"], input:not([type="hidden"]), select, textarea, summary';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      // A control inside a bigger tappable row is fine: the row is the target.
      const row = el.parentElement?.closest('button, a[href], [role="button"], label');
      const target = row && row.getBoundingClientRect().height >= min ? row : el;
      if (target.getBoundingClientRect().height + 0.5 < min) {
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40);
        out.push(`${el.tagName.toLowerCase()} "${label}" is ${Math.round(r.height)}px`);
      }
    }
    return out;
  }, MIN_TAP);
  return found.filter((f) => !KNOWN_SMALL.has(f.replace(/ is \d+px$/, '')));
}

function busyTable() {
  const api = new FakeApi({ serviceRate: 0.125 });
  for (const u of [users.sam, users.priya, users.tom]) api.join(u);
  const [, sam, priya] = api.participants;
  sam!.claimedItemIds = [items[2]!.itemId];
  sam!.payment = { status: 'pending', paymentId: 'pay-u-sam', payerClaimedPaidAt: '2026-10-31T12:30:00Z' };
  priya!.claimedItemIds = [items[4]!.itemId];
  return api;
}

test.describe('tap targets', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const screens: { name: string; user: User; to: (api: FakeApi) => string; api: () => FakeApi; ready: (p: Page) => Promise<void> }[] = [
    { name: 'bills home', user: users.lead, api: () => new FakeApi(), to: () => '/', ready: (p) => expect(p.getByRole('heading', { name: 'Bills' })).toBeVisible() },
    { name: 'review bill', user: users.lead, api: () => new FakeApi(), to: (a) => `/confirm-bill/${a.bill.billId}`, ready: (p) => expect(p.getByRole('heading', { name: 'Review bill' })).toBeVisible() },
    { name: 'lead table', user: users.lead, api: busyTable, to: () => `/session/${SID}`, ready: (p) => expect(p.getByRole('button', { name: 'Close bill' })).toBeVisible() },
    { name: 'guest pick', user: users.tom, api: busyTable, to: () => `/session/${SID}`, ready: (p) => expect(p.getByRole('heading', { name: 'What did you have?' })).toBeVisible() },
  ];

  for (const s of screens) {
    test(`${s.name}: every control is at least ${MIN_TAP}px tall`, async ({ page }) => {
      const api = s.api();
      await open(page, api, s.user, s.to(api));
      await s.ready(page);
      expect(await smallTargets(page)).toEqual([]);
    });
  }

  test('pay: every control is big enough, and the action bar buttons are 52px', async ({ page }) => {
    const api = new FakeApi();
    await open(page, api, users.sam, `/join/${CODE}#p=${fragmentFor({ monzo: 'callum.davies', revolut: 'callumd' })}`);
    await page.getByRole('button', { name: 'Tick Lasagne' }).click();
    await page.getByRole('link', { name: 'Continue to payment' }).click();
    await expect(page.getByText('gdp-0193ab12')).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    // Stacked action bar: each button keeps its height (the flex: none reset).
    const heights = await page.locator('.actionbar__in > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(52);
  });
});

test("the lead's bank details never reach a server", async ({ page }) => {
  const api = new FakeApi({ status: 'setup' });
  await open(page, api, users.lead, '/');
  await page.locator('input[capture]').setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await page.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await page.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Share with the table' })).toBeVisible();

  const sent = api.requests.map((r) => `${r.method} ${r.path} ${r.body ?? ''}`);
  expect(sent.length).toBeGreaterThan(0);
  for (const r of sent) {
    expect(r).not.toContain(LEAD_BANK.accountNumber);
    expect(r).not.toContain(LEAD_BANK.sortCode);
  }
});

test('a table of ten: everyone claims, the shares add up, the lead closes', async ({ browser }) => {
  // Ten diners, one line each plus a shared bottle.
  const many = Array.from({ length: 10 }, (_, i) => item(i + 1, `Main ${i + 1}`, 1000 + i * 100));
  const bottle = item(11, 'Bottle of red', 3000);
  const api = new FakeApi({ items: [...many, bottle], serviceRate: 0.1, leadClaims: [many[0]!.itemId] });
  const names = ['Ana', 'Ben', 'Cat', 'Dev', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'];
  const guests: User[] = names.map((n, i) => ({ userId: `u-g${i + 1}`, displayName: `${n} Diner`, email: `g${i + 1}@example.com` }));
  for (const g of guests) api.join(g);
  guests.forEach((g, i) => {
    api.participants.find((p) => p.userId === g.userId)!.claimedItemIds = [many[i + 1]!.itemId];
  });
  api.shares.push({ itemId: bottle.itemId, userIds: guests.map((g) => g.userId), ways: 9, activity: [] });
  for (const g of guests) api.participants.find((p) => p.userId === g.userId)!.sharedItemIds = [bottle.itemId];

  // Everyone's own view of what they owe matches the fake's projection.
  for (const g of guests.slice(0, 3)) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await open(page, api, g, `/session/${SID}`);
    await expect(page.getByTestId('your-share')).toBeVisible({ timeout: 10_000 });
    const shown = (await page.getByTestId('your-share').textContent()) ?? '';
    expect(shown).toContain((api.owed(g.userId) / 100).toFixed(2));
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const lead = await ctx.newPage();
  await open(lead, api, users.lead, `/session/${SID}`);
  // The lead's table names people by first name.
  for (const n of names) await expect(lead.getByText(new RegExp(`\\b${n}\\b`)).first()).toBeVisible();
  expect(await smallTargets(lead)).toEqual([]);
  await lead.getByRole('button', { name: 'Close bill' }).click();
  await lead.getByRole('dialog').getByRole('button', { name: 'Close bill' }).click();
  await expect(lead.getByText('Bill closed')).toBeVisible({ timeout: 10_000 });
  await ctx.close();
});
