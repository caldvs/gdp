/**
 * #216: the lead opens payments. Until then guests see their items so far,
 * never an amount owed or the lead's bank details, even once every line is
 * claimed. Waiting for the table folds lines away as others claim them.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeApi, SID, fragmentFor, items, users, type User } from './fakeApi';

const POLL = { timeout: 15_000 };
const [olives, , , negroni, martini] = items.map((i) => i.itemId) as [string, string, string, string, string];
// The lead has everything but the calamari and the lasagne.
const leadClaims = [olives, negroni, negroni, martini, martini, martini];

async function diner(browser: Browser, api: FakeApi, user: User, path = `/session/${SID}`): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(path);
  return page;
}

async function claimedMine(page: Page, dish: string) {
  await page.getByRole('button', { name: `Claim ${dish}` }).click();
  await page.getByRole('button', { name: 'I’ve claimed mine' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for the table' })).toBeVisible();
}

test('no guest sees an amount or bank details until the lead opens payments, even with every line claimed', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await expect(sam.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(sam.getByText('Your items so far')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await expect(sam.getByTestId('still-to-claim')).toHaveText('1 line still to claim. You’ll see what you owe when Callum opens payments.');

  // Every line claimed: still nothing to pay.
  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(tom.getByTestId('still-to-claim')).toHaveText('You’ll see what you owe when Callum opens payments.');
  for (const page of [sam, tom]) {
    await expect(page.getByRole('link', { name: 'Continue to payment' })).toHaveCount(0);
    await expect(page.getByText(/incl\. service/)).toHaveCount(0);
  }

  // Straight to the pay page: not yet, and nothing to copy.
  await sam.goto(`/session/${SID}/pay#p=${fragmentFor({})}`);
  await expect(sam.getByRole('heading', { name: 'Not yet' })).toBeVisible();
  await expect(sam.getByText('Sort code')).toHaveCount(0);
  expect(api.participants.find((p) => p.userId === 'u-sam')!.payments ?? []).toEqual([]);
});

test('Waiting for the table folds lines away as others claim, then says every item is claimed', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await claimedMine(sam, 'Calamari');
  const section = (name: string) => sam.locator('section', { has: sam.getByRole('heading', { name }) });
  await expect(section('You claimed')).toContainText('Calamari');
  // The lines nobody has, with no Claim buttons.
  const nobody = section('Nobody’s claimed these yet');
  await expect(nobody).toContainText('Lasagne');
  await expect(nobody.getByRole('button')).toHaveCount(0);
  await expect(sam.getByTestId('wait-status')).toHaveText('Waiting for everyone to claim. Callum opens payments after.');

  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(sam.getByTestId('wait-status')).toHaveText('Every item on the bill is claimed. Waiting for Callum to open payments.', POLL);
  await expect(nobody).toHaveCount(0);
  await expect(sam.getByRole('button', { name: 'See what you owe' })).toHaveCount(0);

  // Claim something else goes back to the list.
  await sam.getByRole('button', { name: 'Claim something else' }).click();
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();
});

test('after the lead opens payments, See what you owe appears for every guest', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);
  await claimedMine(sam, 'Calamari');
  await claimedMine(tom, 'Lasagne');

  // Every line is claimed: the lead's Open payments opens them straight away.
  const lead = await diner(browser, api, users.lead);
  await lead.getByRole('tab', { name: 'The table' }).click();
  await expect(lead.getByTestId('open-pay-status')).toHaveText('Every line is claimed');
  await lead.getByRole('button', { name: 'Open payments' }).click();
  await expect(lead.getByTestId('open-pay-status')).toHaveCount(0);
  expect(api.paymentsOpenedAt).toBeTruthy();

  for (const [page, owed] of [[sam, '£22.50'], [tom, '£17.25']] as const) {
    await page.getByRole('button', { name: 'See what you owe' }).click(POLL);
    await expect(page.getByRole('heading', { name: 'You owe Callum' })).toBeVisible();
    await expect(page.getByTestId('your-share')).toHaveText(owed);
    await expect(page.getByText(/opened payments before every line/)).toHaveCount(0);
  }
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
});

test('the lead can open payments with a line unclaimed; it confirms in place and guests are told', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  await claimedMine(sam, 'Calamari');

  const lead = await diner(browser, api, users.lead);
  await lead.getByRole('tab', { name: 'The table' }).click();
  await expect(lead.getByTestId('open-pay-status')).toHaveText('1 line still to claim');
  await lead.getByRole('button', { name: 'Open payments' }).click();
  const ask = lead.getByRole('group', { name: 'Open payments with lines unclaimed?' });
  await expect(ask).toContainText('Nobody claimed · goes on you£17.25');
  await ask.getByRole('button', { name: 'Keep waiting' }).click();
  expect(api.paymentsOpenedAt).toBeUndefined();
  await lead.getByRole('button', { name: 'Open payments' }).click();
  await ask.getByRole('button', { name: 'Open payments' }).click();
  await expect(ask).toHaveCount(0);
  expect(api.paymentsOpenedAt).toBeTruthy();

  await sam.getByRole('button', { name: 'See what you owe' }).click(POLL);
  await expect(sam.getByText('Callum opened payments before every line was claimed. What you owe won’t change.')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  await expect(sam.getByText(/opened payments before every line/)).toBeVisible();
});
