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

// #177: one list in bill order; each row says whose it is in place.
const GROUPS = { Yours: 'yours', 'Still to claim': 'open', 'Claimed by others': 'others' } as const;
const group = (page: Page, name: keyof typeof GROUPS) => page.locator(`.claim[data-group="${GROUPS[name]}"]`);

test('#130: a 3× line is claimed one portion at a time, never more than were ordered', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);

  await expect(group(sam, 'Still to claim').filter({ hasText: '3 × Espresso Martini' })).toBeVisible();
  await expect(group(sam, 'Still to claim').filter({ hasText: '£13.00 each · 3 left' })).toBeVisible();
  await sam.getByRole('button', { name: 'Claim one Espresso Martini' }).click();
  await expect(group(sam, 'Yours').filter({ hasText: '3 × Espresso Martini' })).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£13.00');
  await sam.getByRole('button', { name: 'One more Espresso Martini' }).click();
  await sam.getByRole('button', { name: 'One more Espresso Martini' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£39.00');
  // All three taken: + stops.
  await expect(sam.getByRole('button', { name: 'One more Espresso Martini' })).toBeDisabled();
  await expect(group(sam, 'Yours').filter({ hasText: 'all claimed' })).toBeVisible();

  // The lead's Your items: all claimed by someone else, no button.
  await lead.getByRole('tab', { name: 'Your items' }).click();
  await expect(group(lead, 'Claimed by others').filter({ hasText: 'All claimed' })).toBeVisible(POLL);
  await expect(lead.getByRole('button', { name: 'Claim one Espresso Martini' })).toHaveCount(0);

  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  await expect(group(lead, 'Still to claim').filter({ hasText: '£13.00 each · 1 left' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  // Back to none: Claim again, and Continue is off until something is claimed.
  await expect(sam.getByRole('button', { name: 'Claim one Espresso Martini' })).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Claim something to continue' })).toBeDisabled();
  expect(api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds).toEqual([]);
});

test('some of a 3× line can be split: the split gets its own row and the rest is claimed one at a time', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Split some Espresso Martini' }).click();
  const sheet = sam.getByRole('dialog', { name: 'Split Espresso Martini' });
  await expect(sheet.getByText('How many?')).toBeVisible();
  // Every one nobody has claimed, to start with.
  await expect(sheet.getByRole('button', { name: 'More Espresso Martini' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Fewer Espresso Martini' }).click();
  await expect(sheet).toContainText('2 × Espresso Martini, £26.00');
  await sheet.getByRole('button', { name: '£13.00 each' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(group(sam, 'Yours').filter({ hasText: '2 × Espresso Martini' })).toContainText('split 2 ways · 1 open');
  await expect(group(sam, 'Still to claim').filter({ hasText: '1 × Espresso Martini' })).toContainText('£13.00 each · 1 left');
  await expect(sam.getByTestId('your-share')).toHaveText('£13.00');

  // Tom takes the open spot and the last one.
  await tom.getByRole('button', { name: 'Join the split for Espresso Martini' }).click(POLL);
  await tom.getByRole('button', { name: 'Claim one Espresso Martini' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£26.00');
  expect(api.shares).toEqual([expect.objectContaining({ itemId: items[4]!.itemId, ways: 2, units: 2, userIds: ['u-sam', 'u-tom'] })]);
  expect(api.participants.find((p) => p.userId === 'u-tom')!.claimedItemIds).toEqual([items[4]!.itemId]);
});

test('#130, #177: claiming one thing ticks its row in place; tapping again puts it back', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(group(sam, 'Yours').filter({ hasText: 'Lasagne' })).toBeVisible();
  await expect(group(sam, 'Yours').filter({ hasText: 'Claimed' })).toBeVisible();
  // Changed in place: still the same row, where it was.
  await expect(sam.locator('.claim').nth(2)).toHaveAttribute('data-group', 'yours');
  await expect(sam.getByRole('link', { name: 'Continue to payment' })).toBeVisible();
  await sam.getByRole('button', { name: 'Remove Lasagne' }).click();
  await expect(group(sam, 'Still to claim').filter({ hasText: 'Lasagne' })).toBeVisible();
  await expect(group(sam, 'Yours')).toHaveCount(0);
});

test('#130: Split on someone else’s dish asks first, then both share it at once', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const priya = await diner(browser, api, users.priya);
  const tom = await diner(browser, api, users.tom);

  await priya.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(priya.getByTestId('your-share')).toHaveText('£22.50');

  await tom.getByRole('button', { name: 'Split Calamari with Priya' }).click(POLL);
  const sheet = tom.getByRole('dialog', { name: 'Split the calamari with Priya?' });
  await expect(sheet).toContainText('Your share£11.25');
  await expect(sheet).toContainText('Priya will see you’re sharing it.');
  await sheet.getByRole('button', { name: 'Split it' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(group(tom, 'Yours').filter({ hasText: '£11.25 · split with Priya' })).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');

  // Told, not asked: Priya's row now says who she's sharing with.
  await expect(group(priya, 'Yours').filter({ hasText: 'split with Tom' })).toBeVisible(POLL);
  await expect(priya.getByTestId('your-share')).toHaveText('£11.25');
  expect(api.shares).toEqual([expect.objectContaining({ itemId: items[1]!.itemId, ways: 2, userIds: ['u-priya', 'u-tom'] })]);
  expect(api.participants.find((p) => p.userId === 'u-priya')!.claimedItemIds).toEqual([]);
});

test('#130: Cancel leaves the dish with whoever claimed it', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.priya);
  api.participants[1]!.claimedItemIds = [items[1]!.itemId];
  const tom = await diner(browser, api, users.tom);
  await tom.getByRole('button', { name: 'Split Calamari with Priya' }).click();
  await tom.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(tom.getByRole('dialog')).toHaveCount(0);
  expect(api.shares).toEqual([]);
});

test('#130: no Split on a dish the person who has it has already paid for', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.priya);
  api.participants[1]!.claimedItemIds = [items[1]!.itemId];
  api.participants[1]!.payment = { status: 'succeeded', paymentId: 'pay-priya', paidAt: '2026-10-31T12:30:00Z' };
  const tom = await diner(browser, api, users.tom);
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Calamari' })).toBeVisible();
  await expect(tom.getByRole('button', { name: /^Split Calamari/ })).toHaveCount(0);
});

test('#123: losing a race for a dish offers Split with Sam', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.sam);
  const tom = await diner(browser, api, users.tom);
  await expect(tom.getByRole('button', { name: 'Claim Calamari' })).toBeVisible();
  // Sam gets there first, before Tom's screen has caught up.
  api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds = [items[1]!.itemId];
  await tom.getByRole('button', { name: 'Claim Calamari' }).click();

  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Sam just took this' })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Split Calamari with Sam' })).toHaveText('Split with Sam');
  await tom.getByRole('button', { name: 'Split Calamari with Sam' }).click();
  await tom.getByRole('dialog').getByRole('button', { name: 'Split it' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');
});

test('two guests grab the last Negroni: the second is told and nothing is claimed', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);
  // Sam takes both before Tom's screen has caught up.
  await sam.getByRole('button', { name: 'Claim one Negroni' }).click();
  await sam.getByRole('button', { name: 'One more Negroni' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£21.00');

  await tom.getByRole('button', { name: 'Claim one Negroni' }).click();
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Sam just took this' })).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Claim something to continue' })).toBeDisabled();
  expect(api.participants.find((p) => p.userId === 'u-tom')!.claimedItemIds).toEqual([]);
});

test('lead starts a split, a guest joins; splitting a full split adds a way and everyone’s price drops', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await lead.getByRole('tab', { name: 'Your items' }).click();
  await lead.getByRole('button', { name: 'Split Calamari', exact: true }).click();
  await lead.getByRole('button', { name: '£11.25 each' }).click();
  await expect(lead.getByRole('button', { name: 'Stop splitting Calamari' })).toBeVisible();

  await sam.getByRole('button', { name: 'Join the split for Calamari' }).click(POLL);
  await expect(sam.getByTestId('your-share')).toHaveText('£11.25');

  // Split is full (2 of 2). Tom splits it too → 3 ways, £7.50 each.
  await tom.getByRole('button', { name: 'Split Calamari with Callum and Sam' }).click(POLL);
  await expect(tom.getByRole('dialog')).toContainText('Your share£7.50');
  await tom.getByRole('dialog').getByRole('button', { name: 'Split it' }).click();
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
  await expect(tom.getByRole('button', { name: 'Claim something to continue' })).toBeDisabled();
  await expect(tom.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible();
  // The lead's items: still 2 ways, one spot free.
  await lead.getByRole('tab', { name: 'Your items' }).click();
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
  const dialog = sam.getByRole('dialog');
  // Two are in it already, so "fewer" is off.
  await expect(dialog.getByRole('button', { name: 'Fewer people' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'More people' }).click();
  await dialog.getByRole('button', { name: '£7.50 each' }).click();
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

  await expect(tom.locator('.row__sub', { hasText: 'Sam took it' })).toBeVisible(POLL);
  await expect(group(tom, 'Claimed by others').filter({ hasText: 'Calamari' })).toBeVisible();
  await expect(tom.getByText('Sam', { exact: true })).toBeVisible();
});

test('service charge: amounts are projected with service and match the lead’s table', async ({ browser }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Claim Calamari' }).click();        // 22.50 → 25.31
  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();         // 17.25 → 19.41
  await expect(sam.getByTestId('your-share')).toHaveText('£25.31');
  await expect(sam.getByText('Your total incl. service')).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£19.41');
  await expect(lead.getByText('£25.31')).toBeVisible(POLL);
  await expect(lead.getByText('£19.41')).toBeVisible();
  // The lead's own olives: 4.25 → 4.78.
  await expect(lead.getByTestId('lead-share')).toHaveText('£4.78');
});

test('picks freeze once the guest has said they’ve sent it', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  // Not sent yet: going back still shows the pick screen.
  await sam.getByRole('link', { name: 'Your items' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('dialog', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  // Sent: the session page is the guest table now, with nothing to claim.
  await expect(sam.getByText('Callum will confirm')).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Claim Calamari' })).toHaveCount(0);
  await expect(sam.getByRole('heading', { name: 'Still to claim' })).toBeVisible();
});

test('#131: the lead lands on Your items, Done goes to The table', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const lead = await diner(browser, api, users.lead);
  await expect(lead.getByRole('tab', { name: 'Your items' })).toHaveAttribute('aria-selected', 'true');
  await lead.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(lead.getByTestId('your-share')).toHaveText('£17.25');
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByRole('tab', { name: 'The table' })).toHaveAttribute('aria-selected', 'true');
  const you = lead.getByRole('button', { name: /^Your items: You/ });
  await expect(you).toContainText('Lasagne');
  await expect(lead.getByTestId('lead-share')).toHaveText('£17.25');
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();
  // Arrow keys move between the tabs.
  await lead.getByRole('tab', { name: 'The table' }).press('ArrowLeft');
  await expect(lead.getByRole('tab', { name: 'Your items' })).toHaveAttribute('aria-selected', 'true');
});

test('#131: Not claimed opens a sheet; Claim takes a line and the sheet closes when none are left', { tag: '@webkit' }, async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  // Sam has the calamari, lasagne and both Negronis; olives and the martinis are left.
  api.participants[1]!.claimedItemIds = [items[1]!.itemId, items[2]!.itemId, items[3]!.itemId, items[3]!.itemId];
  api.participants[0]!.claimedItemIds = [];
  const lead = await diner(browser, api, users.lead);

  await lead.getByRole('tab', { name: 'The table' }).click();
  await lead.getByRole('button', { name: /^Not claimed · 2 items/ }).click();
  const sheet = lead.getByRole('dialog', { name: 'Not claimed' });
  await expect(sheet).toContainText('3 × Espresso Martini');
  await expect(sheet).toContainText('Anything left goes on yours when you close.');
  await sheet.getByRole('button', { name: 'Claim Olives' }).click();
  await expect(sheet.getByText('Olives')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Claim Espresso Martini' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(lead.getByRole('button', { name: /^Not claimed/ })).toHaveCount(0);
  expect(api.participants[0]!.claimedItemIds.sort()).toEqual([items[0]!.itemId, items[4]!.itemId, items[4]!.itemId, items[4]!.itemId].sort());
  await expect(lead.getByTestId('lead-share')).toHaveText('£43.25');
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

  await lead.getByRole('link', { name: 'Full summary' }).click();
  await expect(lead.getByRole('heading', { name: 'Bill summary: Gennaro' })).toBeVisible();
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
    expect(text).toContain('Bill summary: Gennaro');
    expect(text).toContain('Sam · Paid');
    expect(text).toContain('Nobody claimed · goes to Callum');
  }
  await lead.getByRole('link', { name: 'The bill' }).click();
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();
});
