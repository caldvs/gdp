/**
 * Scanning a bill: our own camera with the bill guide, the fallback when
 * there's no camera access, and the "All in?" check before anything uploads.
 * The camera is a canvas stream standing in for getUserMedia, so it runs
 * the same in Chromium and WebKit.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { BID, FakeApi, FORK_BID, SID, users } from './fakeApi';

const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');

type CameraMode = 'fake' | 'denied';

async function lead(browser: Browser, api: FakeApi, camera: CameraMode): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  await ctx.addInitScript((mode: CameraMode) => {
    // On the prototype, not the instance: WebKit can hand the page a
    // mediaDevices object without an instance override, and the real
    // getUserMedia then refuses (NotAllowedError) and the camera shows as off.
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} as MediaDevices });
    const target = typeof MediaDevices === 'undefined' ? navigator.mediaDevices : MediaDevices.prototype;
    target.getUserMedia = async () => {
      if (mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      // A white "receipt" on grey, redrawn so the stream keeps producing frames.
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 1600;
      const g = c.getContext('2d')!;
      const draw = () => {
        g.fillStyle = '#555';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#fff';
        g.fillRect(200, 200, 500, 1200);
        g.fillStyle = '#000';
        g.font = '40px monospace';
        g.fillText('GENNARO', 340, 300);
        g.fillText(`TOTAL ${Date.now() % 100}`, 260, 1300);
      };
      draw();
      setInterval(draw, 100);
      return c.captureStream(10);
    };
  }, camera);
  const page = await ctx.newPage();
  await page.goto('/');
  return page;
}

const uploads = (api: FakeApi) => api.requests.filter((r) => r.method === 'POST' && r.path === '/v1/bills/uploads').length;

test('Scan a bill opens our camera; the shutter goes to the photo check, then the bill is read', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  const page = await lead(browser, api, 'fake');

  await page.getByRole('button', { name: 'Scan a bill' }).click();
  const camera = page.getByRole('dialog', { name: 'Scan a bill' });
  await expect(camera.getByText('Whole bill in the frame')).toBeVisible();
  await expect(camera.getByRole('button', { name: 'Choose a photo' })).toBeVisible();

  await camera.getByRole('button', { name: 'Take photo' }).click();
  await expect(page.getByRole('heading', { name: 'All in?' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('img', { name: 'Your photo of the bill' })).toBeVisible();
  expect(uploads(api)).toBe(0);

  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  expect(uploads(api)).toBe(1);
});

test('closing the camera goes back to Bills', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const page = await lead(browser, api, 'fake');

  await page.getByRole('button', { name: 'Scan a bill' }).click();
  await expect(page.getByText('Whole bill in the frame')).toBeVisible();
  await page.getByRole('button', { name: 'Close camera' }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Scan a bill' })).toHaveCount(0);
});

test('no camera access: falls back to the phone’s camera (the file input)', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const page = await lead(browser, api, 'denied');

  await page.getByRole('button', { name: 'Scan a bill' }).click();
  await expect(page.getByText('No camera access')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await (await chooser).setFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'All in?' })).toBeVisible({ timeout: 15_000 });
});

test('All in? Retake discards the photo without uploading; Use photo uploads once', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  const page = await lead(browser, api, 'denied');

  await page.locator('input[capture]').setInputFiles(PHOTO);
  await expect(page.getByRole('heading', { name: 'All in?' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Retake' }).click();
  // Retake reopens the camera (here, without access).
  await expect(page.getByText('No camera access')).toBeVisible();
  await page.getByRole('button', { name: 'Close camera' }).click();
  expect(uploads(api)).toBe(0);

  await page.locator('input[capture]').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  expect(uploads(api)).toBe(1);
});

// docs/design/analysis-cache.md, step 2: a photo sent before goes back to its bill.
const s3Puts = (api: FakeApi) => api.requests.filter((r) => r.method === 'PUT' && r.path.startsWith('/v1/_s3/')).length;

async function scanFile(page: Page) {
  await page.locator('input[capture]').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'Use photo' }).click();
}

test('the same photo again, after the bill was changed, opens Review bill where they left off', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  api.rememberPhotos = true;
  const page = await lead(browser, api, 'denied');

  await scanFile(page);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Picked up where you left off')).toHaveCount(0);
  api.pinnedBillVersion = 2; // the lead fixed a line

  await page.goto('/');
  await scanFile(page);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Picked up where you left off')).toBeVisible();
  expect(uploads(api)).toBe(2);
  expect(s3Puts(api)).toBe(1);
});

test('the same photo again, once the bill is at a table, opens the lead’s table', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  api.rememberPhotos = true;
  const page = await lead(browser, api, 'denied');

  await scanFile(page);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  // Shared: guests are claiming.
  api.billInSession = true;
  api.status = 'claiming';

  await page.goto('/');
  await scanFile(page);
  await expect(page).toHaveURL(new RegExp(`/session/${SID}$`), { timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'The table' })).toBeVisible();
  expect(s3Puts(api)).toBe(1);
});

/** A photo read, put at a table and settled; then the same photo again. */
async function settledRepeat(browser: Browser) {
  const api = new FakeApi({ status: 'setup' });
  api.rememberPhotos = true;
  const page = await lead(browser, api, 'denied');
  await scanFile(page);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  api.billInSession = true;
  api.status = 'settled';

  await page.goto('/');
  await scanFile(page);
  const sheet = page.getByRole('dialog', { name: 'You split this at Gennaro on Sat 31 Oct' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  return { api, page, sheet };
}

test('the same photo again, once the bill is settled, asks Open or Start again', async ({ browser }) => {
  const { api, sheet } = await settledRepeat(browser);
  await expect(sheet.getByRole('button', { name: 'Start again' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Open' })).toBeVisible();
  expect(s3Puts(api)).toBe(1);
  expect(api.forked).toBe(false);
});

test('Start again on a settled bill opens a fresh Review bill, and the photo then opens it', async ({ browser }) => {
  const { api, page, sheet } = await settledRepeat(browser);
  await sheet.getByRole('button', { name: 'Start again' }).click();
  await expect(page).toHaveURL(new RegExp(`/confirm-bill/${FORK_BID}$`), { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(page.getByText('Picked up where you left off')).toHaveCount(0);
  const fork = api.requests.find((r) => r.path === `/v1/bills/${BID}/fork`);
  expect(JSON.parse(fork!.body!)).toEqual({ from: 'latest' });
  // The old split is left as it was.
  expect(api.status).toBe('settled');

  await page.goto('/');
  await scanFile(page);
  await expect(page).toHaveURL(new RegExp(`/confirm-bill/${FORK_BID}$`), { timeout: 15_000 });
});

test('Open on a settled bill opens the closed bill', async ({ browser }) => {
  const { api, page, sheet } = await settledRepeat(browser);
  await sheet.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/session/${SID}$`), { timeout: 15_000 });
  expect(api.forked).toBe(false);
});
