/** The header coin rolls £ → € → $ → ¥ → £ on every screen size (#178), and stands still for reduced motion. */
import { expect, test, type Page } from '@playwright/test';

const unauthenticated = (page: Page) =>
  page.route('**/v1/me', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'AUTH_MISSING', message: 'No token' } } }),
  );

/** The symbol showing in the coin once the roll is `ms` into its loop. */
async function symbolAt(page: Page, ms: number): Promise<string | null> {
  return page.locator('.brand__roll').evaluate((roll, at) => {
    for (const a of roll.getAnimations()) {
      a.pause();
      a.currentTime = at;
    }
    const mark = roll.parentElement!.getBoundingClientRect();
    const middle = mark.top + mark.height / 2;
    for (const s of Array.from(roll.children)) {
      const r = s.getBoundingClientRect();
      if (r.top <= middle && r.bottom > middle) return s.textContent;
    }
    return null;
  }, ms);
}

test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the coin rolls through the currencies', async ({ page }) => {
    await unauthenticated(page);
    await page.goto('/sign-in');
    const roll = page.locator('.brand__roll');
    await expect(roll).toBeVisible();
    const running = await roll.evaluate((el) => el.getAnimations().map((a) => a.playState));
    expect(running).toEqual(['running']);
    expect(await symbolAt(page, 1000)).toBe('£');
    expect(await symbolAt(page, 4300)).toBe('€');
    expect(await symbolAt(page, 5000)).toBe('$');
    expect(await symbolAt(page, 7000)).toBe('¥');
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the coin stands still on £', async ({ page }) => {
    await unauthenticated(page);
    await page.goto('/sign-in');
    const roll = page.locator('.brand__roll');
    await expect(roll).toBeVisible();
    expect(await roll.evaluate((el) => el.getAnimations().length)).toBe(0);
    expect(await symbolAt(page, 0)).toBe('£');
  });
});
