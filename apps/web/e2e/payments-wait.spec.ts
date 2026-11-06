/**
 * #216: payments wait until every line is claimed. Guests see their items so
 * far, not what they owe, and can't pay; claiming the last line shows every
 * guest their amount; the lead can let people pay now.
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

test('nobody can pay while a line is open: items so far, no amount, no bank details', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);

  await expect(sam.getByRole('button', { name: 'Claim what you had' })).toBeDisabled();
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await expect(sam.getByText('Your items so far')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await expect(sam.getByTestId('still-to-claim')).toHaveText('1 line still to claim. You’ll see what you owe then.');
  await expect(sam.getByRole('link', { name: 'Continue to payment' })).toHaveCount(0);

  // Straight to the pay page: not yet, and nothing to copy.
  await sam.goto(`/session/${SID}/pay#p=${fragmentFor({})}`);
  await expect(sam.getByRole('heading', { name: 'Not yet' })).toBeVisible();
  await expect(sam.getByText('Sort code')).toHaveCount(0);
  expect(api.participants.find((p) => p.userId === 'u-sam')!.payments ?? []).toEqual([]);
});

test('claiming the last line shows every guest what they owe, without a reload', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await sam.getByRole('button', { name: 'I’ve claimed mine' }).click();
  await expect(sam.getByRole('heading', { name: 'Waiting for the table' })).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Claim Lasagne' })).toBeVisible(POLL);

  await tom.getByRole('button', { name: 'Claim Lasagne' }).click();
  // Tom took the last line: payments open for him at once…
  await expect(tom.getByRole('link', { name: 'Continue to payment' })).toBeVisible();
  await expect(tom.getByTestId('your-share')).toHaveText('£17.25');
  // …and Sam's waiting screen turns into what he owes on its next poll.
  await expect(sam.getByText('Every line is claimed')).toBeVisible(POLL);
  await expect(sam.getByRole('heading', { name: 'You owe Callum' })).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
});

test('the lead can let people pay now; amounts don’t change and the guest is told', async ({ browser }) => {
  const api = new FakeApi({ paymentsOpen: false, leadClaims });
  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Claim Calamari' }).click();
  await sam.getByRole('button', { name: 'I’ve claimed mine' }).click();
  await expect(sam.getByRole('heading', { name: 'Waiting for the table' })).toBeVisible();

  const lead = await diner(browser, api, users.lead);
  await lead.getByRole('tab', { name: 'The table' }).click();
  await expect(lead.getByText('Payments open once every line is claimed: 1 to go')).toBeVisible();
  await lead.getByRole('button', { name: 'Let people pay now' }).click();
  const ask = lead.getByRole('group', { name: 'Open payments with lines unclaimed?' });
  await expect(ask).toContainText('Nobody claimed · goes on you£17.25');
  await ask.getByRole('button', { name: 'Open payments' }).click();
  await expect(ask).toHaveCount(0);
  await expect(lead.getByText(/^Payments open once/)).toHaveCount(0);
  expect(api.paymentsOpenedAt).toBeTruthy();

  await expect(sam.getByRole('heading', { name: 'You owe Callum' })).toBeVisible(POLL);
  await expect(sam.getByText('Callum’s letting people pay before every line is claimed. What you owe won’t change.')).toBeVisible();
  await expect(sam.getByTestId('your-share')).toHaveText('£22.50');
  await sam.getByRole('link', { name: 'Pay Callum £22.50' }).click();
  await expect(sam.getByText('gdp-0193ab12')).toBeVisible();
  await expect(sam.getByText('Callum’s letting people pay before every line is claimed.', { exact: false })).toBeVisible();
});
