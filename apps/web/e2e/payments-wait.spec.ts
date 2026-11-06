/**
 * #216: payments open once every line is claimed. Until then guests see
 * their items so far, never an amount owed or the lead's bank details.
 * Waiting for the table folds lines away as others claim them; the lead can
 * open payments early.
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

test('nobody can pay while a line is open: items so far, no amount, no bank details', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);

  await expect(sam.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(sam.getByText('Your items so far')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await expect(sam.getByTestId('still-to-claim')).toHaveText('1 line still to claim. You’ll see what you owe then.');
  await expect(sam.getByRole('link', { name: 'Continue to payment' })).toHaveCount(0);
  await expect(sam.getByText(/incl\. service/)).toHaveCount(0);

  // Straight to the pay page: not yet, and nothing to copy.
  await sam.goto(`/session/${SID}/pay#p=${fragmentFor({})}`);
  await expect(sam.getByRole('heading', { name: 'Not yet' })).toBeVisible();
  await expect(sam.getByText('Sort code')).toHaveCount(0);
  expect(api.participants.find((p) => p.userId === 'u-sam')!.payments ?? []).toEqual([]);
});

test('Waiting for the table folds lines away; claiming the last line shows every guest what they owe', async ({ browser }) => {
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
  await expect(sam.getByRole('button', { name: 'See what you owe' })).toHaveCount(0);

  // Tom takes the last line: open for him at once, with no word from the lead…
  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  await expect(tom.getByRole('link', { name: 'Continue to payment' })).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£17.25');
  // …and Sam's waiting screen folds the line away and opens on its next poll.
  await expect(sam.getByRole('heading', { name: 'Every item on the bill is claimed' })).toBeVisible(POLL);
  await expect(nobody).toHaveCount(0);
  await sam.getByRole('button', { name: 'See what you owe' }).click();
  await expect(sam.getByRole('heading', { name: 'You owe Callum' })).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await expect(sam.getByText(/opened payments before every line/)).toHaveCount(0);
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  expect(api.paymentsOpenedAt).toBeUndefined();
});

test('the lead can open payments early; it confirms in place and guests are told', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  await claimedMine(sam, 'Calamari');

  const lead = await diner(browser, api, users.lead);
  await expect(lead.getByTestId('open-pay-status')).toHaveText('1 line still to claim');
  await lead.getByRole('button', { name: 'Open payments now' }).click();
  const ask = lead.getByRole('group', { name: 'Open payments with lines unclaimed?' });
  await expect(ask).toContainText('Nobody claimed · goes on you£17.25');
  await ask.getByRole('button', { name: 'Keep waiting' }).click();
  expect(api.paymentsOpenedAt).toBeUndefined();
  await lead.getByRole('button', { name: 'Open payments now' }).click();
  await ask.getByRole('button', { name: 'Open payments' }).click();
  await expect(ask).toHaveCount(0);
  await expect(lead.getByTestId('open-pay-status')).toHaveCount(0);
  expect(api.paymentsOpenedAt).toBeTruthy();

  await expect(sam.getByRole('heading', { name: 'Callum has opened payments' })).toBeVisible(POLL);
  await sam.getByRole('button', { name: 'See what you owe' }).click();
  await expect(sam.getByText('Callum opened payments before every line was claimed. What you owe won’t change.')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  await expect(sam.getByText(/opened payments before every line/)).toBeVisible();
});
