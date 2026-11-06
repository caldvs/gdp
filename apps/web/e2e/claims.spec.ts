/**
 * Claims, splits and money, across the lead's and the guests' screens.
 * Every test runs on the in-memory FakeApi with one browser context per
 * diner, so what one person does shows up on the others' tables by poll.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, items, users, type User } from './fakeApi';

// Another page's change arrives on its next poll (every 5s while claiming):
// allow three, for a busy CI runner with several WebKit pages open.
const POLL = { timeout: 15_000 };

async function diner(browser: Browser, api: FakeApi, user: User, opts: { clipboard?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext(opts.clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

// #177, #215: one list in bill order; each row says whose it is in place.
const GROUPS = { Yours: 'yours', 'Still to claim': 'open', 'Claimed by others': 'others' } as const;
const group = (page: Page, name: keyof typeof GROUPS) => page.locator(`[data-row][data-group="${GROUPS[name]}"]`);
const row = (page: Page, key: string) => page.locator(`[data-row="${key}"]`);
const martini = items[4]!.itemId;

test('#215: a guest claims two of three Espresso Martinis a row at a time and splits Sam’s Lasagne in place', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£17.25');

  // One row per portion, numbered, each with its own Claim.
  await expect(row(tom, `${martini}#1`)).toContainText('1 of 3 · 3 left');
  await tom.getByRole('button', { name: 'Claim Espresso Martini 3 of 3' }).click();
  // The row tapped is the one that's claimed; the others stay put.
  await expect(row(tom, `${martini}#3`)).toHaveAttribute('data-group', 'yours');
  await expect(row(tom, `${martini}#1`)).toContainText('1 of 3 · 2 left');
  await tom.getByRole('button', { name: 'Claim Espresso Martini 1 of 3' }).click();
  await expect(row(tom, `${martini}#1`)).toHaveAttribute('data-group', 'yours');
  await expect(row(tom, `${martini}#2`)).toContainText('2 of 3 · 1 left');
  await expect(tom.getByTestId('your-share')).toHaveText('£26.00');

  // Sam's Lasagne: Split opens the row in place, no sheet.
  await tom.getByRole('button', { name: 'More for Lasagne' }).click(POLL);
  await expect(tom.getByRole('dialog')).toHaveCount(0);
  const panel = tom.getByRole('group', { name: 'Split Lasagne' });
  await expect(panel).toContainText('Split it with Sam?');
  await expect(panel).toContainText('Your share£8.62');
  await panel.getByRole('button', { name: 'Split it' }).click();
  await expect(panel).toHaveCount(0);
  await expect(group(tom, 'Yours').filter({ hasText: 'Lasagne' })).toContainText('with Sam');
  await expect(tom.getByTestId('your-share')).toHaveText('£34.62');

  // Told, not asked.
  await expect(group(sam, 'Yours').filter({ hasText: 'Lasagne' })).toContainText('with Tom', POLL);
  expect(api.participants.find((p) => p.userId === 'u-tom')!.claimedItemIds).toEqual([martini, martini]);
  expect(api.shares).toEqual([expect.objectContaining({ itemId: items[2]!.itemId, ways: 2, userIds: ['u-sam', 'u-tom'] })]);
});

test('#215: portions can’t go past what was ordered, and tapping Claimed puts one back', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);

  for (const n of [1, 2, 3]) await sam.getByRole('button', { name: `Claim Espresso Martini ${n} of 3` }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£39.00');
  await expect(sam.getByRole('button', { name: /^Claim Espresso Martini/ })).toHaveCount(0);

  // The lead's Your items: all three have, with no Claim.
  await expect(group(lead, 'Claimed by others').filter({ hasText: 'Sam has it' })).toHaveCount(3, POLL);
  await expect(lead.getByRole('button', { name: /^Claim Espresso Martini/ })).toHaveCount(0);

  await sam.getByRole('button', { name: 'Claimed. Remove Espresso Martini 2 of 3' }).click();
  await expect(row(sam, `${martini}#2`)).toHaveAttribute('data-group', 'open');
  await expect(lead.getByRole('button', { name: /^Claim Espresso Martini/ })).toHaveCount(1, POLL);
  await sam.getByRole('button', { name: 'Claimed. Remove Espresso Martini 1 of 3' }).click();
  await sam.getByRole('button', { name: 'Claimed. Remove Espresso Martini 3 of 3' }).click();
  // Back to none: the main button is off until something is claimed.
  await expect(sam.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  expect(api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds).toEqual([]);
});

test('a split of some of a longer line keeps its own row; the rest are portions after it', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.shares.push({ itemId: martini, userIds: ['u-sam'], ways: 2, units: 2, activity: [] });
  api.participants[1]!.sharedItemIds = [martini];
  const tom = await diner(browser, api, users.tom);

  await expect(row(tom, `${martini}:split`)).toContainText('2 of 3 · Split 2 ways · £13.00 each · 1 open');
  await expect(row(tom, `${martini}#3`)).toContainText('3 of 3 · 1 left');
  await tom.getByRole('button', { name: 'Join the split for Espresso Martini' }).click();
  await tom.getByRole('button', { name: 'Claim Espresso Martini 3 of 3' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£26.00');
  expect(api.shares).toEqual([expect.objectContaining({ itemId: martini, ways: 2, units: 2, userIds: ['u-sam', 'u-tom'] })]);
});

test('#130, #177: claiming one thing ticks its row in place; tapping again puts it back', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(group(sam, 'Yours').filter({ hasText: 'Lasagne' })).toBeVisible();
  await expect(group(sam, 'Yours').filter({ hasText: '✓ Claimed' })).toBeVisible();
  // Changed in place: still the same row, where it was.
  await expect(sam.locator('[data-row]').nth(2)).toHaveAttribute('data-group', 'yours');
  await expect(sam.getByRole('link', { name: 'Continue to payment' })).toBeVisible();
  await sam.getByRole('button', { name: 'Remove Lasagne' }).click();
  await expect(group(sam, 'Still to claim').filter({ hasText: 'Lasagne' })).toBeVisible();
  await expect(group(sam, 'Yours')).toHaveCount(0);
});

test('#130: Cancel leaves the dish with whoever claimed it', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.priya);
  api.participants[1]!.claimedItemIds = [items[1]!.itemId];
  const tom = await diner(browser, api, users.tom);
  await tom.getByRole('button', { name: 'More for Calamari' }).click();
  await tom.getByRole('group', { name: 'Split Calamari' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(tom.getByRole('group', { name: 'Split Calamari' })).toHaveCount(0);
  await expect(tom.getByRole('button', { name: 'More for Calamari' })).toBeFocused();
  expect(api.shares).toEqual([]);
});

test('#130: no Split on a dish the person who has it has already paid for', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.priya);
  api.participants[1]!.claimedItemIds = [items[1]!.itemId];
  api.participants[1]!.payment = { status: 'succeeded', paymentId: 'pay-priya', paidAt: '2026-10-31T12:30:00Z' };
  const tom = await diner(browser, api, users.tom);
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Calamari' })).toContainText('Priya has it');
  await expect(tom.getByRole('button', { name: 'More for Calamari' })).toHaveCount(0);
});

test('#123: losing a race for a dish still offers a split with Sam', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.sam);
  const tom = await diner(browser, api, users.tom);
  await expect(tom.getByRole('button', { name: 'Claim Calamari' })).toBeVisible();
  // Sam gets there first, before Tom's screen has caught up.
  api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds = [items[1]!.itemId];
  await tom.getByRole('button', { name: 'Claim Calamari' }).click();

  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Sam just took this' })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'More for Calamari' })).toBeVisible();
  await tom.getByRole('button', { name: 'More for Calamari' }).click();
  await tom.getByRole('group', { name: 'Split Calamari' }).getByRole('button', { name: 'Split it' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');
});

test('two guests grab the last Negroni: the second is told and nothing is claimed', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);
  // Sam takes both before Tom's screen has caught up.
  await sam.getByRole('button', { name: 'Claim Negroni 1 of 2' }).click();
  await sam.getByRole('button', { name: 'Claim Negroni 2 of 2' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£21.00');

  await tom.getByRole('button', { name: 'Claim Negroni 2 of 2' }).click();
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Sam just took this' })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  expect(api.participants.find((p) => p.userId === 'u-tom')!.claimedItemIds).toEqual([]);
});

test('splitting someone’s dish, then splitting the full split, adds a way and everyone’s price drops', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await lead.getByRole('button', { name: 'Claim Calamari' }).click();
  await sam.getByRole('button', { name: 'More for Calamari' }).click(POLL);
  await sam.getByRole('group', { name: 'Split Calamari' }).getByRole('button', { name: 'Split it' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£11.25');

  // Split is full (2 of 2). Tom splits it too → 3 ways, £7.50 each.
  await expect(tom.getByText(/Callum and Sam/).first()).toBeVisible(POLL);
  await tom.getByRole('button', { name: 'More for Calamari' }).click();
  const panel = tom.getByRole('group', { name: 'Split Calamari' });
  await expect(panel).toContainText('£7.50');
  await expect(panel.getByRole('button', { name: 'More ways' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Split it' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£7.50');
  await expect(sam.getByTestId('your-share')).toHaveText('£7.50', POLL);
  await expect(lead.getByText('3 ways').first()).toBeVisible(POLL);
  expect(api.shares[0]).toMatchObject({ ways: 3, userIds: ['u-lead', 'u-sam', 'u-tom'] });
});

test('leaving a split reopens the spot', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.join(users.tom);
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-sam', 'u-tom'], ways: 2, activity: [] });
  api.participants[1]!.sharedItemIds = [items[1]!.itemId];
  api.participants[2]!.sharedItemIds = [items[1]!.itemId];
  const lead = await diner(browser, api, users.lead);
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');
  await tom.getByRole('button', { name: 'Stop splitting Calamari' }).click();
  await expect(tom.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  await expect(tom.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible();
  // The lead's items: still 2 ways, one spot free.
  await expect(lead.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible(POLL);
  expect(api.shares[0]).toMatchObject({ ways: 2, userIds: ['u-sam'] });
});

test('changing ways: 2 → 3 updates the other member, and can’t go below the people in it', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.join(users.tom);
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-sam', 'u-tom'], ways: 2, activity: [] });
  api.participants[1]!.sharedItemIds = [items[1]!.itemId];
  api.participants[2]!.sharedItemIds = [items[1]!.itemId];
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Change how many ways Calamari is split' }).click();
  const panel = sam.getByRole('group', { name: 'Split Calamari' });
  // Two are in it already, so "fewer" is off.
  await expect(panel.getByRole('button', { name: 'Fewer ways' })).toBeDisabled();
  await panel.getByRole('button', { name: 'More ways' }).click();
  await expect(panel).toContainText('£7.50');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£7.50');
  await expect(tom.getByTestId('your-share')).toHaveText('£7.50', POLL);
  await expect(tom.getByText('3 ways').first()).toBeVisible();
});

test('#123: a row someone else just took flashes who took it, then settles to their name', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByRole('button', { name: 'Claim Calamari' })).toBeVisible();
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();

  await expect(tom.locator('.receipt__note', { hasText: 'Sam took it' })).toBeVisible(POLL);
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Calamari' })).toContainText('Sam has it');
});

test('service charge: amounts are projected with service and match the lead’s table', async ({ browser }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Claim Calamari' }).click();        // 22.50 → 25.31
  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();         // 17.25 × 117.00 / 104.00 = 19.406, rounded down
  await expect(sam.getByTestId('your-share')).toHaveText('£25.31');
  await expect(sam.getByText('Your total incl. service')).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£19.40');
  await expect(lead.getByText('£25.31')).toBeVisible(POLL);
  await expect(lead.getByText('£19.40')).toBeVisible();
  // The lead takes the rest: 117.00 − 25.31 − 19.40 − 67.50 nobody has
  // claimed yet = 4.79 (their olives, 4.78, and the penny left over).
  await expect(lead.getByTestId('lead-share')).toHaveText('£4.79');
});

test('picks freeze once the guest has said they’ve sent it', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('Gennaro Sam')).toBeVisible();
  // Not sent yet: going back still shows the pick screen.
  await sam.getByRole('link', { name: 'Your items' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('group', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  // Sent: the session page is the guest table now, with nothing to claim.
  await expect(sam.getByText('Waiting for Callum to mark it received')).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Claim Calamari' })).toHaveCount(0);
  await expect(sam.getByRole('button', { name: 'I had something else' })).toBeVisible();
});

test('#217: the lead’s bill is one page: what needs them, Claim on the bill, lines nobody has tinted, who’s paid', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  // Sam has the calamari, lasagne and both Negronis; olives and the martinis are left.
  api.participants[1]!.claimedItemIds = [items[1]!.itemId, items[2]!.itemId, items[3]!.itemId, items[3]!.itemId];
  api.participants[0]!.claimedItemIds = [];
  const lead = await diner(browser, api, users.lead);

  const needs = lead.getByRole('list', { name: 'What needs you' });
  await expect(needs).toContainText('2 lines nobody’s claimed · £43.25');
  await expect(lead.locator('[data-row][data-group="open"]')).toHaveCount(4);
  await lead.getByRole('button', { name: 'Claim Olives, £4.25' }).click();
  await expect(needs).toContainText('1 line nobody’s claimed · £39.00');
  await expect(lead.getByTestId('lead-share')).toHaveText('£4.25');
  for (const n of ['1', '2', '3']) await lead.getByRole('button', { name: `Claim Espresso Martini ${n} of 3, £13.00` }).click();
  await expect(needs).toHaveCount(0);
  expect(api.participants[0]!.claimedItemIds.sort()).toEqual([items[0]!.itemId, items[4]!.itemId, items[4]!.itemId, items[4]!.itemId].sort());
  await expect(lead.getByTestId('lead-share')).toHaveText('£43.25');
  await expect(lead.getByRole('heading', { name: 'Who’s paid' })).toBeVisible();
  await expect(lead.getByRole('tab')).toHaveCount(0);
});

test('#131: the full summary is a plain statement the lead can email or copy', async ({ browser, browserName }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.join(users.tom);
  const sam = api.participants[1]!;
  sam.claimedItemIds = [items[1]!.itemId];
  sam.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T21:30:00Z' };
  api.participants[2]!.claimedItemIds = [items[2]!.itemId, items[3]!.itemId];
  const lead = await diner(browser, api, users.lead, { clipboard: browserName === 'chromium' });

  await lead.getByRole('link', { name: 'The whole bill' }).click();
  await expect(lead.getByRole('heading', { name: 'The whole bill: Gennaro' })).toBeVisible();
  await expect(lead.getByRole('table', { name: 'Callum' })).toContainText('Olives£4.25');
  await expect(lead.getByRole('table', { name: 'Sam' })).toContainText('Paid');
  await expect(lead.getByRole('table', { name: 'Sam' })).toContainText('Calamari£22.50');
  await expect(lead.getByRole('table', { name: 'Tom' })).toContainText('Not paid');
  await expect(lead.getByRole('table', { name: 'Tom' })).toContainText('Negroni (1 of 2)£10.50');
  await expect(lead.getByRole('table', { name: 'Nobody claimed' })).toContainText('Espresso Martini (3 of 3)£39.00');
  await expect(lead.getByText('Outstanding')).toBeVisible();
  await expect(lead.getByText('Callum’s position')).toBeVisible();

  await lead.getByRole('button', { name: 'Email this' }).click();
  await expect(lead.getByRole('button', { name: 'Emailed' })).toBeDisabled();
  expect(api.reportsTo).toEqual(['u-lead']);

  if (browserName === 'chromium') {
    await lead.getByRole('button', { name: 'Copy as text' }).click();
    await expect(lead.getByRole('button', { name: 'Copied' })).toBeVisible();
    const text = await lead.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('The whole bill: Gennaro');
    expect(text).toContain('Sam · Paid');
    expect(text).toContain('Nobody claimed · goes to Callum');
  }
  await lead.getByRole('link', { name: 'The bill' }).click();
  await expect(lead.getByRole('button', { name: 'Mark as settled' })).toBeVisible();
});
