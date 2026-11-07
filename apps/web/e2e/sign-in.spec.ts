/**
 * Sign in with the 6-digit code from the email, typed (or filled in by the
 * phone) in the same tab that asked. Nothing opens a new tab, so where the
 * person was going (a join link's `#p=` included) is never lost.
 */
import { expect, test, type Page } from '@playwright/test';
import { FakeApi, SIGN_IN_CODE, users } from './fakeApi';

async function askForCode(page: Page, path = '/sign-in/email') {
  await page.goto(path);
  await page.getByLabel('Email').fill('sam@example.com');
  await page.locator('form:has(#email) button[type="submit"]').click();
  await expect(page.getByLabel('Code sent to sam@example.com')).toBeFocused();
  // How long it lasts is said, and read out with the field (#203).
  await expect(page.getByLabel('Code sent to sam@example.com')).toHaveAccessibleDescription(/Works for 15 minutes/);
}

async function newPage(browser: import('@playwright/test').Browser) {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { signedIn: false, atTable: false });
  return { api, ctx, page: await ctx.newPage() };
}

test('the code typed digit by digit signs in as soon as it is whole', { tag: '@webkit' }, async ({ browser }) => {
  const { api, ctx, page } = await newPage(browser);
  await askForCode(page);
  await page.getByLabel(/Code sent to/).pressSequentially(SIGN_IN_CODE);
  await expect(page).not.toHaveURL(/\/sign-in/);
  expect(api.signIn).toBe('used');
  await ctx.close();
});

test('a code filled in at once (pasted, or from the phone) signs in', { tag: '@webkit' }, async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  await askForCode(page);
  // Spaces and dashes from a paste are ignored.
  await page.getByLabel(/Code sent to/).fill(`${SIGN_IN_CODE.slice(0, 3)} ${SIGN_IN_CODE.slice(3)}`);
  await expect(page).not.toHaveURL(/\/sign-in/);
  await ctx.close();
});

test('a wrong code says how many tries are left, and the right one still works', async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  await askForCode(page);
  const box = page.getByLabel(/Code sent to/);
  await box.fill('000000');
  await expect(page.getByText('Wrong code. 4 tries left.')).toBeVisible();
  await expect(box).toHaveValue('');
  await box.fill(SIGN_IN_CODE);
  await expect(page).not.toHaveURL(/\/sign-in/);
  await ctx.close();
});

test('a used-up code says so and sends a new one', async ({ browser }) => {
  const { api, ctx, page } = await newPage(browser);
  await askForCode(page);
  api.codeTries = 1;
  await page.getByLabel(/Code sent to/).fill('000000');
  await expect(page.getByText('Code expired. Send a new one.')).toBeVisible();
  await expect(page.getByLabel(/Code sent to/)).toBeDisabled();
  // The resend wait from the first send still applies.
  await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled();
  await ctx.close();
});

test('Continue with a short code asks for all 6 digits', async ({ browser }) => {
  const { api, ctx, page } = await newPage(browser);
  await askForCode(page);
  await page.getByLabel(/Code sent to/).fill('123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter the 6-digit code.')).toBeVisible();
  expect(api.requests.filter((r) => r.path === '/v1/auth/email/verify')).toHaveLength(0);
  await ctx.close();
});

test('the code step survives a reload, and Different email goes back', async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  await askForCode(page);
  await page.reload();
  await expect(page.getByLabel('Code sent to sam@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Different email' }).click();
  await page.reload();
  await expect(page.getByLabel('Email')).toBeVisible();
  await ctx.close();
});

test('an old sign-in link goes to the sign-in screen', async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  await page.goto('/sign-in/verify#t=old.token');
  await expect(page).toHaveURL(/\/sign-in\/email/);
  await expect(page.getByLabel('Email')).toBeVisible();
  await ctx.close();
});
