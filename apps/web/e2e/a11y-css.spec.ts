/**
 * Accessibility the axe run can't see: focus rings that a card would clip
 * (#201), buttons and prefixed inputs at large text and wide spacing (#202),
 * and the demo banner's close button (#205). Chromium only.
 */
import { expect, test, type Page } from '@playwright/test';
import { FakeApi, SID, items, users, type User } from './fakeApi';

test.beforeEach(({ browserName }, info) => {
  test.skip(info.project.name !== 'desktop' || browserName !== 'chromium', 'one browser is enough');
});
test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

async function open(page: Page, api: FakeApi, user: User, to: string) {
  await api.attach(page.context(), user);
  await page.goto(to);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** WCAG's text-spacing override (1.4.12), as the bookmarklet applies it. */
const TEXT_SPACING = `* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
p { margin-bottom: 2em !important; }`;

/** Doubles every element's font size: text-only zoom to 200% (1.4.4). */
async function doubleText(page: Page) {
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
    els.forEach((el, i) => el.style.setProperty('font-size', `${sizes[i]! * 2}px`, 'important'));
  });
}

/** Buttons whose text spills out of them, sideways or down. */
async function clippedButtons(page: Page): Promise<string[]> {
  return page.locator('.btn').evaluateAll((els) =>
    els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map((el) => `"${(el.textContent ?? '').trim()}" ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`),
  );
}

/** Whether the focused element's outline lies inside its card's clipping box. */
async function ringInsideCard(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const box = el.closest('.box')!;
    const s = getComputedStyle(el);
    const grow = parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(box).borderTopWidth);
    return {
      visible: el.matches(':focus-visible') && s.outlineStyle !== 'none',
      inside: r.left - grow >= b.left + border - 0.5 && r.right + grow <= b.right - border + 0.5,
    };
  });
}

test('a focused row in a card has its whole ring showing (#201)', async ({ page }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  api.join(users.sam);
  await open(page, api, users.lead, `/session/${SID}`);
  const row = page.getByRole('button', { name: /^Not claimed/ });
  await expect(row).toBeVisible();
  await page.keyboard.press('Tab');
  await row.focus();
  expect(await ringInsideCard(page)).toEqual({ visible: true, inside: true });
});

test('a focused claim button in a card keeps its ring outside, and it shows (#201)', async ({ page }) => {
  await open(page, new FakeApi(), users.sam, `/session/${SID}`);
  const claim = page.getByRole('button', { name: `Claim ${items[2]!.name}` });
  await expect(claim).toBeVisible();
  await page.keyboard.press('Tab');
  await claim.focus();
  expect(await claim.evaluate((el) => getComputedStyle(el).outlineOffset)).toBe('2px');
  expect(await ringInsideCard(page)).toEqual({ visible: true, inside: true });
});

test('a long button label wraps rather than clipping, at 200% text and with wide spacing (#202)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const api = new FakeApi({ serviceRate: 0.125 });
  await open(page, api, users.lead, `/confirm-bill/${api.bill.billId}`);
  await expect(page.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await page.locator('.actionbar__in').evaluate((bar) => {
    bar.insertAdjacentHTML('afterbegin', '<button type="button" class="btn btn--primary">Pay £2.00 fee &amp; get QR code</button>');
  });
  await page.addStyleTag({ content: TEXT_SPACING });
  expect(await clippedButtons(page)).toEqual([]);
  await doubleText(page);
  expect(await clippedButtons(page)).toEqual([]);
  const long = page.getByRole('button', { name: 'Pay £2.00 fee & get QR code' });
  expect((await long.boundingBox())!.height).toBeGreaterThan(52);
  // Side-by-side buttons too wide for one line go one above the other.
  const right = await page.locator('.actionbar .btn').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
  expect(right).toBeLessThanOrEqual(320);
});

test('the Monzo and Revolut prefixes never sit over what’s typed (#202)', async ({ page }) => {
  await open(page, new FakeApi(), users.lead, '/payout-account');
  await page.getByRole('button', { name: 'Add Monzo or Revolut (optional)' }).click();
  const gaps = async () =>
    page.locator('.affix').evaluateAll((els) =>
      els.map((el) => {
        const span = el.querySelector('span')!.getBoundingClientRect();
        const input = el.querySelector('input')!;
        return Math.round(input.getBoundingClientRect().left - span.right);
      }),
    );
  expect(await gaps()).toEqual([0, 0]);
  await page.addStyleTag({ content: TEXT_SPACING });
  await doubleText(page);
  for (const g of await gaps()) expect(g).toBeGreaterThanOrEqual(0);
  // Focus inside still shows on the field.
  await page.getByLabel('Monzo username').focus();
  expect(await page.locator('.affix').first().evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('the demo banner’s close button is 44px square with a white focus ring (#205)', async ({ page }) => {
  // The banner only renders in a demo build, so put its markup on a page to test the styles.
  await open(page, new FakeApi(), users.lead, '/');
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div class="demo-banner" role="status"><span class="demo-banner__tag">demo</span><span>Trying the app as a guest.</span><button type="button" class="demo-banner__close" aria-label="Dismiss demo banner for this session">×</button></div>',
    ),
  );
  const close = page.getByRole('button', { name: 'Dismiss demo banner for this session' });
  const box = (await close.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Tab');
  await close.focus();
  const ring = await close.evaluate((el) => {
    const s = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), style: s.outlineStyle, colour: s.outlineColor };
  });
  expect(ring).toEqual({ visible: true, style: 'solid', colour: 'rgb(255, 255, 255)' });
});
