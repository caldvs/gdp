/**
 * The emailed link, opened the way most people open it on a laptop: in a
 * new tab of the same browser. The tab that asked must end up signed in
 * whatever order its polls land in.
 *
 * 4 Nov 2026, paymeback.dev: the link tab was confirmed and closed, the
 * asking tab polled twice on refocus (0.5 s apart), the first poll
 * collected the session and the second was told `expired`, and the page
 * said "Link expired" though the sign-in had worked.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { FakeApi, SIGN_IN_CODE, SIGN_IN_LINK_TOKEN, users } from './fakeApi';

const POLL = { timeout: 10_000 };

async function askForLink(page: Page) {
  await page.goto('/sign-in/email');
  await page.getByLabel('Email').fill('sam@example.com');
  await page.locator('form:has(#email) button[type="submit"]').click();
  await expect(page.getByText('Check your email')).toBeVisible();
  await expect(page.getByTestId('sign-in-code')).toHaveText(SIGN_IN_CODE);
}

/** Click the email's button: a new tab in the same browser, Yes, close it. */
async function openLinkInNewTab(ctx: BrowserContext) {
  const linkTab = await ctx.newPage();
  await linkTab.goto(`/sign-in/verify#t=${SIGN_IN_LINK_TOKEN}`);
  await expect(linkTab.getByRole('heading', { name: `Signing in the tab showing ${SIGN_IN_CODE}?` })).toBeVisible();
  await linkTab.getByRole('button', { name: 'Yes' }).click();
  await expect(linkTab.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  await linkTab.close();
}

/** Back to the asking tab: it regains focus, which fires an extra poll. */
async function backTo(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

async function expectSignedInAtHome(page: Page) {
  await expect(page).not.toHaveURL(/\/sign-in/, POLL);
  await expect(page.getByText('Link expired')).toHaveCount(0);
}

test('link opened in a new tab of the same browser: the asking tab signs in', async ({ browser }) => {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { signedIn: false, atTable: false });
  const asker = await ctx.newPage();
  await askForLink(asker);
  await openLinkInNewTab(ctx);
  await backTo(asker);
  await expectSignedInAtHome(asker);
  // Polled again after collecting, and wasn't talked out of it.
  await asker.waitForTimeout(2500);
  await expect(asker.getByText('Link expired')).toHaveCount(0);
  await ctx.close();
});

test('a late `expired` after `signedIn` never undoes the sign-in', async ({ browser }) => {
  // The server as it was before the fix: the session once, then expired.
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { signedIn: false, atTable: false });
  let collected = 0;
  await ctx.route('**/v1/auth/email/requests', async (route) => {
    if (api.signIn === 'pending') return route.fulfill({ json: { status: 'pending' } });
    // Answer slowly so the next poll overlaps, the way a refocus does.
    await new Promise((r) => setTimeout(r, 300));
    if (collected++ === 0) return route.fulfill({ json: { status: 'signedIn', token: 'test-token', user: users.sam } });
    return route.fulfill({ json: { status: 'expired' } });
  });
  const asker = await ctx.newPage();
  await askForLink(asker);
  await openLinkInNewTab(ctx);
  await backTo(asker);
  await backTo(asker);
  await expectSignedInAtHome(asker);
  await ctx.close();
});

test('`expired` while another tab of this browser signed in: carry on signed in', async ({ browser }) => {
  // Even if the asking tab never gets its own session, the link tab's
  // sign-in is shared by the whole browser.
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { signedIn: false, atTable: false });
  await ctx.route('**/v1/auth/email/requests', (route) =>
    route.fulfill({ json: { status: api.signIn === 'pending' ? 'pending' : 'expired' } }),
  );
  const asker = await ctx.newPage();
  await askForLink(asker);
  await openLinkInNewTab(ctx);
  await backTo(asker);
  await expectSignedInAtHome(asker);
  await ctx.close();
});

test('a genuinely expired request still says so and lets you send a new link', async ({ browser }) => {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await api.attach(ctx, users.sam, { signedIn: false, atTable: false });
  const asker = await ctx.newPage();
  await askForLink(asker);
  await ctx.route('**/v1/auth/email/requests', (route) => route.fulfill({ json: { status: 'expired' } }));
  await expect(asker.getByText('Link expired. Send a new one.')).toBeVisible(POLL);
  await expect(asker.getByLabel('Email')).toBeVisible();
  await ctx.close();
});
