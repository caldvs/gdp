/**
 * Claiming with a keyboard and a screen reader (#195, #196, #199): focus
 * stays on the row while a claim saves and its controls swap, busy buttons
 * keep their names, and claim buttons say the price.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, items, users, type User } from './fakeApi';

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

/** Holds POSTs to `path` until the returned function is called. */
async function hold(page: Page, path: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(`**/v1/sessions/${SID}/${path}`, async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.fallback();
  });
  return release;
}

test('#195: claiming by keyboard keeps focus on the row, busy or not', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  const release = await hold(sam, 'claims');

  await sam.getByRole('button', { name: 'Claim Lasagne' }).focus();
  await sam.keyboard.press('Enter');
  // Claim became Claimed (optimistically), and focus went with it.
  const claimed = sam.getByRole('button', { name: 'Claimed. Remove Lasagne' });
  await expect(claimed).toBeFocused();
  // While it saves: unavailable but still focused, and a second press does nothing.
  await expect(claimed).toHaveAttribute('aria-disabled', 'true');
  await sam.keyboard.press('Enter');
  release();
  await expect(claimed).not.toHaveAttribute('aria-disabled');
  await expect(claimed).toBeFocused();
  expect(api.participants.find((p) => p.userId === users.sam.userId)!.claimedItemIds).toEqual([items[2]!.itemId]);

  // And back again.
  await sam.keyboard.press('Enter');
  await expect(sam.getByRole('button', { name: 'Claim Lasagne' })).toBeFocused();
});

test('#195: the stepper keeps focus, and moves to − when + runs out', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Claim one Espresso Martini' }).focus();
  await sam.keyboard.press('Enter');
  const more = sam.getByRole('button', { name: 'One more Espresso Martini' });
  await expect(more).toBeFocused();
  // A busy stepper ignores presses (#196), and keyboard.press doesn't wait
  // for it the way click does, so wait for each claim to land first.
  await expect(more).not.toHaveAttribute('aria-disabled');
  await sam.keyboard.press('Enter');
  await expect(sam.locator(`.claim[data-row="${items[4]!.itemId}"] .stepper span`)).toHaveText('2');
  await expect(more).toBeFocused();
  await expect(more).not.toHaveAttribute('aria-disabled');
  await sam.keyboard.press('Enter');
  await expect(more).toBeDisabled();
  await expect(sam.getByRole('button', { name: 'One fewer Espresso Martini' })).toBeFocused();
});

test('#196: a busy button keeps its name', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.priya);
  api.participants.find((p) => p.userId === users.priya.userId)!.claimedItemIds = [items[1]!.itemId];
  const tom = await diner(browser, api, users.tom);
  const release = await hold(tom, 'shares');

  let posts = 0;
  tom.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/shares')) posts++; });
  await tom.getByRole('button', { name: 'Split Calamari with Priya' }).click();
  const dialog = tom.getByRole('dialog');
  await expect(dialog).toHaveAccessibleDescription('Priya will see you’re sharing it.');
  const ok = dialog.getByRole('button', { name: 'Split it' });
  await ok.focus();
  await tom.keyboard.press('Enter');
  await expect(ok).toHaveAttribute('aria-busy', 'true');
  await expect(ok).toHaveAccessibleName('Split it');
  // Busy, not disabled: focus stays put, and pressing again sends nothing more.
  await expect(ok).toHaveAttribute('aria-disabled', 'true');
  await expect(ok).toBeFocused();
  await tom.keyboard.press('Enter');
  release();
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(1);
});

test('#199: claim buttons say the price; taken rows say who by', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.priya);
  api.join(users.tom);
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-priya'], ways: 2, activity: [] });
  api.participants.find((p) => p.userId === users.priya.userId)!.sharedItemIds = [items[1]!.itemId];
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByRole('button', { name: 'Claim Lasagne, £17.25', exact: true })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Claim one Espresso Martini, £13.00', exact: true })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Join the split for Calamari, £11.25 each', exact: true })).toBeVisible();
  // Olives are the lead's.
  const olives = tom.locator('.claim[data-group="others"]').filter({ hasText: 'Olives' });
  await expect(olives.getByText('Taken by', { exact: true })).toBeAttached();
  await expect(olives).toContainText('Taken by');

  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(tom.getByRole('button', { name: 'Claimed. Remove Lasagne, £17.25', exact: true })).toBeVisible();
});
