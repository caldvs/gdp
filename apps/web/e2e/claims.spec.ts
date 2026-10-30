/**
 * Claims, splits and money, across the lead's and the guests' screens.
 * Every test runs on the in-memory FakeApi with one browser context per
 * diner, so what one person does shows up on the others' tables by poll.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, items, users, type User } from './fakeApi';

const POLL = { timeout: 10_000 };

async function diner(browser: Browser, api: FakeApi, user: User): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(`/session/${SID}`);
  return page;
}

test('a 3× line: guest steps 1 → 3 → 0, the lead sees "n left" move each step', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);

  await sam.getByRole('button', { name: 'Take one Espresso Martini' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£13.00');
  await sam.getByRole('button', { name: 'One more Espresso Martini' }).click();
  await sam.getByRole('button', { name: 'One more Espresso Martini' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£39.00');
  // All three taken: no more.
  await expect(sam.getByRole('button', { name: 'One more Espresso Martini' })).toBeDisabled();
  await expect(lead.getByText('Sam', { exact: true }).first()).toBeVisible(POLL);
  await expect(lead.getByText('Espresso Martini × 3')).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Take Espresso Martini' })).toHaveCount(0);

  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  await expect(lead.getByText('Sam · 1 left · £13.00 each')).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  await sam.getByRole('button', { name: 'One fewer Espresso Martini' }).click();
  // Back to none: the row is a plain tick again and the Pay button is off.
  await expect(sam.getByRole('button', { name: 'Take one Espresso Martini' })).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Tick what you had' })).toBeDisabled();
  expect(api.participants.find((p) => p.userId === 'u-sam')!.claimedItemIds).toEqual([]);
});

test('a 3× line on the lead’s table: − n + goes all the way to 0', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const row = (n: string) => lead.getByRole('button', { name: n });

  await row('Take Espresso Martini').click();
  await row('One more Espresso Martini').click();
  await row('One more Espresso Martini').click();
  await expect(row('One more Espresso Martini')).toBeDisabled();
  await expect(lead.getByText('£39.00')).toBeVisible();
  await row('One fewer Espresso Martini').click();
  await row('One fewer Espresso Martini').click();
  await row('One fewer Espresso Martini').click();
  await expect(row('Take Espresso Martini')).toBeVisible();
  expect(api.participants[0]!.claimedItemIds).toEqual([items[0]!.itemId]);
});

test('lead starts a split, a guest joins; joining a full split adds a way and everyone’s price drops', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await lead.getByRole('button', { name: 'Split Calamari' }).click();
  await lead.getByRole('button', { name: '£11.25 each' }).click();
  await expect(lead.getByRole('button', { name: 'Leave the split for Calamari' })).toBeVisible();

  await sam.getByRole('button', { name: 'Join the split for Calamari' }).click(POLL);
  await expect(sam.getByTestId('your-share')).toHaveText('£11.25');

  // Split is full (2 of 2). Tom joins anyway → 3 ways, £7.50 each.
  await expect(tom.getByText('2 ways')).toBeVisible(POLL);
  await tom.getByRole('button', { name: 'Join the split for Calamari' }).click();
  await expect(tom.getByTestId('your-share')).toHaveText('£7.50');
  await expect(sam.getByTestId('your-share')).toHaveText('£7.50', POLL);
  await expect(lead.getByText('3 ways').first()).toBeVisible(POLL);
  expect(api.shares[0]).toMatchObject({ ways: 3, userIds: ['u-lead', 'u-sam', 'u-tom'] });
});

test('leaving a split reopens the seat', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  api.join(users.tom);
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-sam', 'u-tom'], ways: 2, activity: [] });
  api.participants[1]!.sharedItemIds = [items[1]!.itemId];
  api.participants[2]!.sharedItemIds = [items[1]!.itemId];
  const lead = await diner(browser, api, users.lead);
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByTestId('your-share')).toHaveText('£11.25');
  await tom.getByRole('button', { name: 'Leave the split for Calamari' }).click();
  await expect(tom.getByRole('button', { name: 'Tick what you had' })).toBeDisabled();
  await expect(tom.getByRole('button', { name: 'Join the split for Calamari' })).toBeVisible();
  // The lead's table: still 2 ways, one seat free.
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

test('two guests grab the last Negroni: the second is refused and their row snaps back', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);
  // Sam takes both before Tom's screen has caught up.
  await sam.getByRole('button', { name: 'Take one Negroni' }).click();
  await sam.getByRole('button', { name: 'One more Negroni' }).click();
  await expect(sam.getByTestId('your-share')).toHaveText('£21.00');

  await tom.getByRole('button', { name: 'Take one Negroni' }).click();
  await expect(tom.getByText('Only 0 of "Negroni" left')).toBeVisible();
  await expect(tom.getByRole('button', { name: 'Tick what you had' })).toBeDisabled();
  await expect(tom.getByText('Sam', { exact: true })).toBeVisible(POLL);
  expect(api.participants.find((p) => p.userId === 'u-tom')!.claimedItemIds).toEqual([]);
});

test('#123: a row someone else just took flashes who took it, then settles to an avatar', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByRole('button', { name: 'Tick Calamari' })).toBeVisible();
  await sam.getByRole('button', { name: 'Tick Calamari' }).click();

  // Tom's row never disappears — it flashes "Sam took it" and settles to her initial.
  await expect(tom.locator('.row__sub', { hasText: 'Sam took it' })).toBeVisible(POLL);
  await expect(tom.getByText('Calamari')).toBeVisible();
  await expect(tom.getByText('Sam', { exact: true })).toBeVisible();
});

test('#123: Hide taken folds rows someone else has fully claimed, Show taken brings them back', async ({ browser }) => {
  const api = new FakeApi({ leadClaims: [] });
  api.join(users.sam);
  api.participants[1]!.claimedItemIds = [items[0]!.itemId, items[1]!.itemId];
  const tom = await diner(browser, api, users.tom);

  await expect(tom.getByText('Olives')).toBeVisible();
  await expect(tom.getByText('Calamari')).toBeVisible();
  await tom.getByRole('button', { name: 'Hide taken' }).click();

  await expect(tom.getByText('Olives')).toHaveCount(0);
  await expect(tom.getByText('Calamari')).toHaveCount(0);
  await expect(tom.getByRole('button', { name: 'Show taken (2)' })).toBeVisible();

  await tom.getByRole('button', { name: 'Show taken (2)' }).click();
  await expect(tom.getByText('Olives')).toBeVisible();
  await expect(tom.getByText('Calamari')).toBeVisible();
});

test('service charge: amounts are projected with service and add up to the lead’s "to come"', async ({ browser }) => {
  const api = new FakeApi({ serviceRate: 0.125 });
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Tick Calamari' }).click();        // 22.50 → 25.31
  await tom.getByRole('button', { name: 'Tick Lasagne' }).click();         // 17.25 → 19.41
  await expect(sam.getByTestId('your-share')).toHaveText('£25.31');
  await expect(sam.getByText('Your share incl. service')).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£19.41');
  // Lead: 25.31 + 19.41 = 44.72, and the diner rows carry the same figures.
  await expect(lead.getByText('£44.72')).toBeVisible(POLL);
  await expect(lead.getByText('£25.31')).toBeVisible();
  await expect(lead.getByText('£19.41')).toBeVisible();
});

test('picks freeze once the guest has said they’ve sent it', async ({ browser }) => {
  const api = new FakeApi();
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Tick Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  // Not sent yet: going back still shows the pick screen.
  await sam.getByRole('link', { name: 'Your items' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  // Sent: the session page is the guest table now, with no ticks to tap.
  await expect(sam.getByText('Callum will confirm')).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Tick Calamari' })).toHaveCount(0);
  await expect(sam.getByRole('heading', { name: 'Still to claim' })).toBeVisible();
});

test('the lead covers the leftovers in one go, and can still hand one back', async ({ browser }) => {
  const api = new FakeApi();
  api.join(users.sam);
  // Sam has the calamari, lasagne and both Negronis; olives and the martinis are left.
  api.participants[1]!.claimedItemIds = [items[1]!.itemId, items[2]!.itemId, items[3]!.itemId, items[3]!.itemId];
  api.participants[0]!.claimedItemIds = [];
  const lead = await diner(browser, api, users.lead);

  await lead.getByRole('button', { name: /I’ll cover these · £/ }).click();
  await expect(lead.getByRole('heading', { name: 'Items · all claimed' })).toBeVisible();
  expect(api.participants[0]!.claimedItemIds.sort()).toEqual([items[0]!.itemId, items[4]!.itemId, items[4]!.itemId, items[4]!.itemId].sort());
  await expect(lead.getByRole('button', { name: /I’ll cover these/ })).toHaveCount(0);

  await lead.getByRole('button', { name: 'Hand back Olives' }).click();
  await expect(lead.getByRole('button', { name: 'I’ll cover these · £4.25' })).toBeVisible();
});
