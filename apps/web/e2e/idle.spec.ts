/**
 * Idle sign-out (#200, WCAG 2.2.1): an hour without activity signs you
 * out, with a "Still there?" warning two minutes before. Guests are never
 * signed out for being idle (#183). Playwright's clock fast-forwards time.
 */
import { expect, test, type Browser } from '@playwright/test';
import { CODE, FakeApi, SID, fragmentFor, users } from './fakeApi';

async function signedIn(browser: Browser) {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await ctx.clock.install();
  await api.attach(ctx, users.lead);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  // The menu button shows once signed in, which is when the idle clock starts.
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  return { page, ctx };
}

test('a warning two minutes before the idle sign-out; Stay signed in restarts the hour', async ({ browser }) => {
  const { page, ctx } = await signedIn(browser);
  const warning = page.getByRole('dialog', { name: 'Still there?' });

  await page.clock.fastForward('57:30');
  await page.clock.runFor(10_000);
  await expect(warning).toHaveCount(0);

  await page.clock.fastForward('01:00');
  await page.clock.runFor(10_000);
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('within 2 minutes');
  await warning.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(warning).toHaveCount(0);

  // A fresh hour from the tap.
  await page.clock.fastForward('30:00');
  await page.clock.runFor(10_000);
  await expect(warning).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/session/${SID}$`));
  await ctx.close();
});

test('ignoring the warning signs you out, keeping where you were', async ({ browser }) => {
  const { page, ctx } = await signedIn(browser);
  await page.clock.fastForward('58:30');
  await page.clock.runFor(10_000);
  await expect(page.getByRole('dialog', { name: 'Still there?' })).toBeVisible();
  await page.clock.fastForward('02:00');
  await page.clock.runFor(10_000);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?from=${encodeURIComponent(`/session/${SID}`)}$`));
  await ctx.close();
});

for (const [what, move] of [
  ['focus moving', 'focus'],
  ['scrolling', 'scroll'],
] as const) {
  test(`${what}, with no pointer or key, counts as activity (screen readers)`, async ({ browser }) => {
    const { page, ctx } = await signedIn(browser);
    await page.clock.fastForward('40:00');
    await page.evaluate((move) => {
      if (move === 'scroll') { window.dispatchEvent(new Event('scroll')); return; }
      (document.activeElement as HTMLElement | null)?.blur();
      document.querySelector<HTMLElement>('header a[href]')?.focus();
    }, move);
    await page.clock.fastForward('40:00');
    await page.clock.runFor(10_000);
    await expect(page.getByRole('dialog', { name: 'Still there?' })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/session/${SID}$`));
    await ctx.close();
  });
}

test('a guest is never signed out for being idle (#183)', async ({ browser }) => {
  const api = new FakeApi();
  const ctx = await browser.newContext();
  await ctx.clock.install();
  await api.attach(ctx, users.sam, { signedIn: false });
  const sam = await ctx.newPage();
  await sam.goto(`/join/${CODE}#p=${fragmentFor()}`);
  await sam.getByLabel('Your name').fill('Sam');
  await sam.getByRole('button', { name: 'Join the bill' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible({ timeout: 10_000 });

  await sam.clock.fastForward('02:00:00');
  await sam.clock.runFor(10_000);
  await expect(sam.getByRole('dialog', { name: 'Still there?' })).toHaveCount(0);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await expect(sam).not.toHaveURL(/sign-in/);
  await ctx.close();
});
