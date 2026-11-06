/**
 * #213 M4 / M4.1: sign in with your phone where the server has it on, and
 * email everywhere else until it's live.
 */
import { expect, test, type Browser } from '@playwright/test';
import { FakeApi, PHONE_CODE, users } from './fakeApi';

async function signedOut(browser: Browser, api: FakeApi, path = '/sign-in/email') {
  const ctx = await browser.newContext();
  await api.attach(ctx, users.lead, { signedIn: false, atTable: false });
  const page = await ctx.newPage();
  await page.goto(path);
  return page;
}

test('phone off: the email sign-in, as before', async ({ browser }) => {
  const page = await signedOut(browser, new FakeApi());
  await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
  await expect(page.getByLabel('Your mobile number')).toHaveCount(0);
});

test('phone on: number, the 4-digit code by WhatsApp, a wrong try, then signed in', async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  const page = await signedOut(browser, api, `/sign-in/email?from=${encodeURIComponent('/history')}`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('We’ll send you a 4-digit code by WhatsApp.')).toBeVisible();

  await page.getByLabel('Your mobile number').fill('020 7946 0000');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.locator('main [role=alert], form [role=alert]').first()).toHaveText('Enter a UK mobile number, like 07700 900123.');

  await page.getByLabel('Your mobile number').fill('07700 900123');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
  await expect(page.getByText('Sent to +44 7700 900123 on WhatsApp. Works for 10 minutes.')).toBeVisible();
  await expect(page.getByText(/^New code in \d:\d\d$/)).toBeVisible();

  const code = page.getByLabel('4-digit code');
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await code.fill('1111');
  await expect(page.locator('main [role=alert], form [role=alert]').first()).toHaveText('Wrong code. 4 tries left.');
  await code.fill(PHONE_CODE);
  await expect(page).toHaveURL(/\/history$/);
});

test('a new phone account gives its name and bill email first', async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  api.phoneIsNew = true;
  const page = await signedOut(browser, api, `/sign-in/email?from=${encodeURIComponent('/history')}`);
  await page.getByLabel('Your mobile number').fill('7700900123');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('4-digit code').fill(PHONE_CODE);
  await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('main [role=alert], form [role=alert]').first()).toHaveText('Enter your name.');
  await page.getByLabel('Your name').fill('Callum');
  await page.getByLabel('Email').fill('Callum@Example.com');
  await expect(page.getByLabel('Email')).toHaveAccessibleDescription('For your bill emails. Not used to sign in.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/history$/);
  expect(api.profilePatches).toEqual([{ displayName: 'Callum', email: 'callum@example.com' }]);
});

test('phone on, email still there: Use email instead', async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  const page = await signedOut(browser, api);
  await page.getByRole('button', { name: 'Use email instead' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('#231 texts where WhatsApp isn’t set up', async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  api.phoneChannel = 'sms';
  const page = await signedOut(browser, api);
  await expect(page.getByText('We’ll text you a 4-digit code.')).toBeVisible();
  await page.getByLabel('Your mobile number').fill('07700 900123');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByText('Sent to +44 7700 900123 by text. Works for 10 minutes.')).toBeVisible();
  expect(api.lastPhoneChannel).toBe('sms');
  await page.getByLabel('4-digit code').fill(PHONE_CODE);
  await expect(page).not.toHaveURL(/sign-in/);
});

test('#231 texts when both are on: Callum chose SMS', async ({ browser }) => {
  const api = new FakeApi();
  api.phoneSignIn = true;
  const page = await signedOut(browser, api);
  await page.route('**/v1/auth/methods', (r) => r.fulfill({ json: { email: true, phone: true, whatsapp: true, sms: true } }));
  await page.reload();
  await expect(page.getByText('We’ll text you a 4-digit code.')).toBeVisible();
});
