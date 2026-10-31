import { expect, test, type Page } from '@playwright/test';

const unauthenticated = (page: Page) =>
  page.route('**/v1/me', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'No token' } } }),
  );
// Local dev sign-in isn't on the test server; the form falls back to email codes.
const noDevSignIn = (page: Page) =>
  page.route('**/v1/auth/email/dev-sign-in', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'no' } } }),
  );

test('signed-out visitors land on the front door', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Split the bill, get paid back' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('a join link survives the sign-in redirect without leaking the bank details', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/join/ABC123#p=secret-payload');
  await expect(page).toHaveURL(/\/sign-in\?from=%2Fjoin%2FABC123$/);
  // The #p= fragment is parked in this tab's sessionStorage, never in a URL.
  expect(page.url()).not.toContain('secret-payload');
  expect(await page.evaluate(() => sessionStorage.getItem('gdp.pendingJoinFragment'))).toBe('#p=secret-payload');
});

test('email step validates before calling the API', async ({ page }) => {
  await unauthenticated(page);
  await noDevSignIn(page);
  let called = false;
  await page.route('**/v1/auth/email/start', (route) => {
    called = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/sign-in');
  const submit = page.locator('form button[type="submit"]');
  await page.getByLabel('Email').fill('not-an-email');
  await submit.click();
  await expect(page.getByText("That doesn't look like an email address.")).toBeVisible();
  expect(called).toBe(false);

  await page.getByLabel('Email').fill('alice@example.com');
  await submit.click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  expect(called).toBe(true);
});

test('signed-in home lists your bills, with Scan and the menu', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('gdp.idToken', 'test-token');
    localStorage.setItem('gdp.lastActiveAt', String(Date.now()));
  });
  await page.route('**/v1/me', (route) =>
    route.fulfill({ json: { userId: 'u1', displayName: 'Alice Cooper', email: 'alice@example.com' } }),
  );
  await page.route('**/v1/me/sessions**', (route) =>
    route.fulfill({ json: { sessions: [{ sessionId: 's1', status: 'claiming', creatorUserId: 'u1', collectorUserId: 'u1', billId: 'b1', pinnedBillVersion: 1, createdAt: new Date().toISOString(), role: 'lead', myPaymentStatus: 'self_paid', venue: { name: 'Gennaro' } }] } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan a bill' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Gennaro/ })).toBeVisible();
});
