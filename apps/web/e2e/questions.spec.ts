/**
 * #61, #135: while the bill is read, the lead says how many are eating
 * (2 to start). Once it's read, the place on the receipt is shown; the
 * lead is asked where they are only when there was none, or when they
 * change it, and the browser's location only when they tap for it. Kept
 * until the bill is ready, then sent once.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { FakeApi, LEAD_BANK, users } from './fakeApi';

const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');

/** The lead on Bills, with the browser's location shared or refused. */
async function lead(browser: Browser, api: FakeApi, where: 'shared' | 'refused'): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead);
  await ctx.addInitScript((shared: boolean) => {
    const geo = {
      getCurrentPosition: (ok: PositionCallback, fail?: PositionErrorCallback | null) => {
        if (shared) setTimeout(() => ok({ coords: { latitude: 53.48403, longitude: -2.23371, accuracy: 20 } } as GeolocationPosition), 50);
        else setTimeout(() => fail?.({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError), 50);
      },
      watchPosition: () => 0,
      clearWatch: () => undefined,
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  }, where === 'shared');
  const page = await ctx.newPage();
  await page.goto('/');
  return page;
}

async function scan(page: Page) {
  await page.locator('input[capture]').setInputFiles(PHOTO);
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByRole('heading', { name: 'Reading your bill' })).toBeVisible({ timeout: 15_000 });
}

/** Review bill → bank details → share, as the lead's first bill. */
async function share(page: Page) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await page.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await page.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
}

const sent = (api: FakeApi, method: string, p: string) =>
  api.requests.filter((r) => r.method === method && r.path === p).map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);

test('the place on the receipt comes first; Change picks a place nearby, which beats it', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup', venue: { name: 'd Maiora - Italian Sandwich Shop', address: '84 Tib Street' } });
  api.nearby = [
    { placeId: 'here-ad-maiora', name: 'Ad Maiora', address: '84 Tib St, Manchester, M4 1LG, England', distanceM: 12 },
    { placeId: 'here-other', name: 'Bar Pop', address: '10 Tib St, Manchester, M4 1SH, England', distanceM: 140 },
  ];
  api.holdReads = true;
  const page = await lead(browser, api, 'shared');
  await scan(page);

  // While reading: how many (2 to start), and no location asked for.
  await expect(page.getByLabel('2 people')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where are you?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByRole('button', { name: 'More people' }).click();
  await expect(page.getByLabel('4 people')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reading…' })).toBeDisabled();

  // Read: the receipt's place is shown, with Change.
  api.holdReads = false;
  await expect(page.getByRole('heading', { name: 'Bill read' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('d Maiora - Italian Sandwich Shop')).toBeVisible();
  expect(api.requests.some((r) => r.path === '/v1/venues/nearby')).toBe(false);

  // Change → Use my location → the places near them.
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByRole('radio', { name: /Ad Maiora/ })).toBeVisible();
  await expect(page.getByText('84 Tib St · 10 m')).toBeVisible();
  await page.getByRole('radio', { name: /Ad Maiora/ }).check();
  await page.getByRole('button', { name: 'Review bill' }).click();

  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(page.getByText(/^Ad Maiora · 5 items/)).toBeVisible();
  await expect(page.getByText('84 Tib St, Manchester, M4 1LG, England')).toBeVisible();
  await share(page);

  const amends = sent(api, 'POST', '/v1/bills/0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b/amend').filter((b) => (b.venue as { placeId?: string } | undefined)?.placeId);
  expect(amends).toHaveLength(1);
  expect(amends[0]!.venue).toEqual({ name: 'Ad Maiora', placeId: 'here-ad-maiora', address: '84 Tib St, Manchester, M4 1LG, England' });
  expect(sent(api, 'POST', '/v1/sessions')).toHaveLength(1);
  expect(sent(api, 'POST', '/v1/sessions')[0]).toMatchObject({ expectedDiners: 4 });

  // Used once: opening the bill again sends nothing more.
  await page.goto('/confirm-bill/0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b');
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(sent(api, 'POST', '/v1/bills/0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b/amend').filter((b) => (b.venue as { placeId?: string } | undefined)?.placeId)).toHaveLength(1);
});

test('touching nothing: the receipt’s place stays and the table is for 2', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  api.nearby = [{ placeId: 'p1', name: 'Somewhere near', address: '12 King St, Manchester', distanceM: 30 }];
  api.readPolls = 2;
  const page = await lead(browser, api, 'shared');
  await scan(page);
  await page.getByRole('button', { name: 'Review bill' }).click({ timeout: 15_000 });
  await expect(page.getByText(/^Gennaro · 5 items/)).toBeVisible();
  await share(page);
  expect(sent(api, 'POST', '/v1/sessions')[0]).toMatchObject({ expectedDiners: 2 });
  expect(sent(api, 'POST', '/v1/bills/0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b/amend').some((b) => b.venue)).toBe(false);
  expect(api.requests.some((r) => r.path === '/v1/venues/nearby')).toBe(false);
});

test('no place on the receipt: asked by name, location only on tap; answers survive a failed read', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup', venue: null });
  api.nearby = [{ placeId: 'never', name: 'Never shown', distanceM: 5 }];
  api.faults.push({ kind: 'parse', code: 'PARSE_TIMEOUT', message: 'Bedrock took too long to read the bill' });
  api.holdReads = true;
  const page = await lead(browser, api, 'refused');
  await scan(page);
  await page.getByRole('button', { name: 'More people' }).click();

  // The read fails; Try again reads the same photo, and the answer is still there.
  api.holdReads = false;
  await expect(page.getByRole('heading', { name: 'That took too long.' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Bill read' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('3 people')).toBeVisible();

  // Nothing on the receipt: a name field, and location only when asked.
  await expect(page.getByLabel('Name of the place')).toBeVisible();
  expect(api.requests.some((r) => r.path === '/v1/venues/nearby')).toBe(false);
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByRole('button', { name: 'Location unavailable' })).toBeDisabled();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByLabel('Name of the place').fill('The Dog & Partridge');

  await page.getByRole('button', { name: 'Review bill' }).click();
  await expect(page.getByText(/^The Dog & Partridge · 5 items/)).toBeVisible();
  await share(page);
  expect(sent(api, 'POST', '/v1/sessions')[0]).toMatchObject({ expectedDiners: 3 });
});

test('an answer given after the read has finished still counts', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  const page = await lead(browser, api, 'refused');
  await scan(page).catch(() => undefined);
  await expect(page.getByRole('heading', { name: 'Bill read' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByRole('button', { name: 'More people' }).click();
  await page.getByRole('button', { name: 'Review bill' }).click();
  await share(page);
  expect(sent(api, 'POST', '/v1/sessions')[0]).toMatchObject({ expectedDiners: 4 });
});
