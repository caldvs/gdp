import { expect, test, type Page } from '@playwright/test';

const unauthenticated = (page: Page) =>
  page.route('**/v1/me', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'No token' } } }),
  );
// Local dev sign-in isn't on the test server; the form falls back to email links.
const noDevSignIn = (page: Page) =>
  page.route('**/v1/auth/email/dev-sign-in', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'no' } } }),
  );

test('signed-out visitors land on the front door', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: /Pay the bill/ })).toBeVisible();
  // No sign-in card on the homepage (H1/H3): Sign in opens its own screen.
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in\/email$/);
  await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('a redirect to sign in asks for the email straight away', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/sign-in?from=%2Fhistory');
  await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('#183: a join link opens without signing in, and the bank details leave the address bar', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/join/ABC123#p=secret-payload');
  await expect(page).toHaveURL(/\/join\/ABC123$/);
  expect(page.url()).not.toContain('secret-payload');
});

test('a join link leaves the address bar before /me answers (#147)', async ({ page }) => {
  // /me never answers, so the shell keeps waiting and the join screen never mounts.
  await page.route('**/v1/me', () => {});
  await page.goto('/join/ABC123#p=secret-payload');
  await expect(page).toHaveURL(/\/join\/ABC123$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  expect(await page.evaluate(() => sessionStorage.getItem('gdp.pendingJoinFragment'))).toBe('#p=secret-payload');
});

test('email step validates before calling the API', async ({ page }) => {
  await unauthenticated(page);
  await noDevSignIn(page);
  let called = false;
  await page.route('**/v1/auth/email/start', (route) => {
    called = true;
    return route.fulfill({ json: { ok: true, requestId: 'req.1' } });
  });
  await page.goto('/sign-in/email');
  const submit = page.locator('form:has(#email) button[type="submit"]');
  await page.getByLabel('Email').fill('not-an-email');
  await submit.click();
  await expect(page.getByText("That doesn't look like an email address.")).toBeVisible();
  expect(called).toBe(false);

  await page.getByLabel('Email').fill('alice@example.com');
  await submit.click();
  await expect(page.getByLabel('Code sent to alice@example.com')).toBeVisible();
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
