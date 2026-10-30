import { expect, test, type Page } from '@playwright/test';

const unauthenticated = (page: Page) =>
  page.route('**/v1/me', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'No token' } } }),
  );

test('signed-out visitors land on sign-in', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sort the bill.' })).toBeVisible();
  await expect(page.getByLabel('your email')).toBeVisible();
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
  let called = false;
  await page.route('**/v1/auth/email/start', (route) => {
    called = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/sign-in');
  await page.getByLabel('your email').fill('not-an-email');
  await page.getByRole('button', { name: 'Email me a code →' }).click();
  await expect(page.getByText("That doesn't look like an email address.")).toBeVisible();
  expect(called).toBe(false);

  await page.getByLabel('your email').fill('alice@example.com');
  await page.getByRole('button', { name: 'Email me a code →' }).click();
  await expect(page.getByText('check your inbox')).toBeVisible();
  expect(called).toBe(true);
});

test('signed-in home shows the greeting and a new-bill button', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gdp.idToken', 'test-token'));
  await page.route('**/v1/me', (route) =>
    route.fulfill({ json: { userId: 'u1', displayName: 'Alice Cooper', email: 'alice@example.com' } }),
  );
  await page.route('**/v1/me/sessions**', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/');
  await expect(page.getByText(/, Alice$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /New bill/ })).toBeVisible();
  await expect(page.getByText('Nothing yet. Snap a bill to start.')).toBeVisible();
});
