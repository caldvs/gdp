/**
 * Keyboard focus (#192, #193, #194): sheets and the camera take focus, keep
 * Tab inside, close on Escape and hand focus back; a new screen's heading
 * takes focus so it's read out. Chromium only: WebKit doesn't Tab to buttons
 * by default.
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { FakeApi, SID, items, users, type User } from './fakeApi';

const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');

test.beforeEach(({ browserName }, info) => {
  test.skip(info.project.name !== 'desktop' || browserName !== 'chromium', 'keyboard focus: one browser');
});

async function open(page: Page, api: FakeApi, user: User, to: string) {
  await api.attach(page.context(), user);
  await page.goto(to);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** True when focus is on `el` or inside it. */
const focusIn = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement && !!document.querySelector(s)?.contains(document.activeElement), selector);

function tableWithOneUnclaimed() {
  const api = new FakeApi({ serviceRate: 0.125 });
  api.join(users.sam);
  api.participants[1]!.claimedItemIds = [items[2]!.itemId];
  return api;
}

test('a sheet takes focus, keeps Tab inside, closes on Escape and hands focus back', async ({ page }) => {
  await open(page, tableWithOneUnclaimed(), users.lead, `/session/${SID}`);
  const trigger = page.getByRole('button', { name: 'How many eating?' });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const sheet = page.getByRole('dialog', { name: 'How many eating?' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeFocused();

  // Round the sheet and past it: focus never leaves.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await focusIn(page, 'dialog[open]')).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusIn(page, 'dialog[open]')).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a tap outside the sheet closes it and focus goes back', async ({ page }) => {
  await open(page, new FakeApi(), users.sam, `/session/${SID}`);
  const trigger = page.getByRole('button', { name: 'More', exact: true });
  await trigger.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Tab can’t reach the page behind a sheet', async ({ page }) => {
  await open(page, tableWithOneUnclaimed(), users.lead, `/session/${SID}`);
  await page.getByRole('button', { name: 'How many eating?' }).click();
  await expect(page.getByRole('dialog')).toBeFocused();
  const reached = new Set<string>();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    reached.add(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
  }
  expect([...reached].sort()).toEqual(['Cancel', 'More people', 'Save']);
});

test('going to another page focuses its heading', async ({ page }) => {
  await open(page, new FakeApi(), users.lead, '/');
  await expect(page.getByRole('heading', { name: 'Bills', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Account' }).click();
  const heading = page.getByRole('heading', { name: 'Account', level: 1 });
  await expect(heading).toBeFocused();

  // And back, by keyboard.
  await page.getByRole('link', { name: 'Bills' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Bills', level: 1 })).toBeFocused();
});

test('the camera takes focus, keeps Tab inside, closes on Escape back to Scan a bill', async ({ page }) => {
  await page.addInitScript(() => {
    const target = typeof MediaDevices === 'undefined' ? navigator.mediaDevices : MediaDevices.prototype;
    target.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await open(page, new FakeApi(), users.lead, '/');
  await page.getByRole('button', { name: 'Scan a bill' }).focus();
  await page.keyboard.press('Enter');

  const camera = page.getByRole('dialog', { name: 'Scan a bill' });
  await expect(camera.getByText('No camera access')).toBeVisible();
  await expect(camera).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await focusIn(page, 'dialog.cam')).toBe(true);
  }
  // The ring is white on the black camera.
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineColor)).toBe('rgb(255, 255, 255)');

  await page.keyboard.press('Escape');
  await expect(camera).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Scan a bill' })).toBeFocused();
});

test('a new step on the same page focuses its heading (photo → All in?)', async ({ page }) => {
  await page.addInitScript(() => {
    const target = typeof MediaDevices === 'undefined' ? navigator.mediaDevices : MediaDevices.prototype;
    target.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await open(page, new FakeApi(), users.lead, '/');
  await page.getByRole('button', { name: 'Scan a bill' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'All in?', level: 1 })).toBeFocused({ timeout: 15_000 });
});
