import { expect, test } from '@playwright/test';

// Storybook is built into public/storybook by `npm run build` (not on prod).
test('/storybook opens Storybook and shows a story', async ({ page }) => {
  await page.goto('/storybook?path=/story/feedback-notice--info');
  await expect(page).toHaveURL(/\/storybook\/index\.html/);
  const story = page.frameLocator('#storybook-preview-iframe');
  await expect(story.getByText('Bill changed')).toBeVisible();
});

test('only Storybook may be framed, and only by the site', async ({ request }) => {
  const app = await request.get('/');
  expect(app.headers()['x-frame-options']).toBe('DENY');
  const sb = await request.get('/storybook/iframe.html');
  expect(sb.ok()).toBe(true);
  expect(sb.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(sb.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
});
