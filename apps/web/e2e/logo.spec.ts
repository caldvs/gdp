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

/** Fonts loaded and the page's own entrance (fade and rise) finished. */
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document.getAnimations()
        // Endless ones (the coin itself, a spinner) never finish.
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
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
    await settled(page);
    // Polled: on a busy runner the page can still be moving into place.
    await expect.poll(() => symbolAt(page, 1000)).toBe('£');
    await expect.poll(() => symbolAt(page, 4300)).toBe('€');
    await expect.poll(() => symbolAt(page, 5000)).toBe('$');
    await expect.poll(() => symbolAt(page, 7000)).toBe('¥');
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
    await settled(page);
    await expect.poll(() => symbolAt(page, 0)).toBe('£');
  });
});
