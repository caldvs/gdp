/**
 * The lead's journey: scan → review → bank details → share, parse errors,
 * fixing the bill mid-session, binning, closing.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { FakeApi, LEAD_BANK, SID, items, users, type User } from './fakeApi';

const POLL = { timeout: 10_000 };
const PHOTO = path.join(__dirname, 'fixtures', 'bill.jpg');

async function diner(browser: Browser, api: FakeApi, user: User, goto = `/session/${SID}`): Promise<Page> {
  const ctx = await browser.newContext();
  await api.attach(ctx, user);
  const page = await ctx.newPage();
  await page.goto(goto);
  return page;
}

test('snap → check (fix a price, a quantity) → bank details → share; the second bill skips bank details', async ({ browser }) => {
  const api = new FakeApi({ status: 'setup' });
  const lead = await diner(browser, api, users.lead, '/');

  await lead.locator('input[capture]').setInputFiles(PHOTO);

  await lead.getByRole('button', { name: 'Use photo' }).click();

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByText('Gennaro · 5 items')).toBeVisible();

  // Fix the calamari's price and make it two.
  await lead.getByRole('button', { name: 'Edit Calamari' }).click();
  await lead.getByLabel('Price each').fill('20.00');
  // #204: the stepper says which item.
  await expect(lead.getByRole('button', { name: 'One fewer Calamari' })).toBeDisabled();
  await lead.getByRole('button', { name: 'One more Calamari' }).click();
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByText('£40.00')).toBeVisible();

  // First time: no bank details yet → asked for them, then straight on to share.
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Bank details' })).toBeVisible();
  await lead.getByLabel('Name on the account').fill(LEAD_BANK.accountHolderName);
  await lead.getByLabel('Sort code').fill(LEAD_BANK.sortCode);
  await lead.getByLabel('Account number').fill(LEAD_BANK.accountNumber);
  await lead.getByRole('button', { name: 'Save and continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
  await expect(lead.getByText('Point a phone camera here')).toBeVisible();
  await expect(lead.getByText('K7Q2MX')).toHaveCount(0);
  // The amend went through with the edited line.
  const amend = api.requests.find((r) => r.path.endsWith('/amend'));
  expect(amend?.body).toContain('"unitPricePence":2000');
  expect(amend?.body).toContain('"quantity":2');

  // Second bill on the same device: bank details are remembered, no detour.
  api.status = 'setup';
  await lead.goto('/');
  await lead.locator('input[capture]').setInputFiles(PHOTO);
  await lead.getByRole('button', { name: 'Use photo' }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
  await lead.getByRole('button', { name: 'Continue' }).click();
  await expect(lead.getByRole('heading', { name: 'Share with the table' })).toBeVisible();
});

test('a cut-off photo: no printed total to check, Retake photo goes back to scanning', async ({ browser }) => {
  const api = new FakeApi({ noPrintedTotal: true });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByText('No total on the photo')).toBeVisible();
  await expect(lead.getByText('Bottom cut off? We can\u2019t check the sum.')).toBeVisible();

  await lead.getByRole('button', { name: 'Retake photo' }).click();
  await expect(lead.getByRole('heading', { name: 'Scan a bill' })).toBeVisible();
});

test('a printed total that matches the sum: no notice, shown as matching', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByText('No total on the photo')).toHaveCount(0);
  await expect(lead.getByText('matches the receipt')).toBeVisible();
});

test('#107 lines that don’t make the printed total: a notice that goes once a price is fixed', async ({ browser }) => {
  // Lines make £104.00; the receipt says £106.50 (Calamari is really £25.00).
  const api = new FakeApi({ printedTotalPence: 10650 });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByText('Doesn’t add up')).toBeVisible();
  await expect(lead.getByText(/£2\.50 under the receipt’s £106\.50/)).toBeVisible();
  await expect(lead.getByText('matches the receipt')).toHaveCount(0);
  await lead.getByRole('button', { name: 'See photo' }).click();
  await expect(lead.getByRole('button', { name: 'Hide photo' })).toBeVisible();

  await lead.getByRole('button', { name: /Calamari/ }).click();
  await lead.getByLabel('Price each').fill('25.00');
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByText('Doesn’t add up')).toHaveCount(0);
  await expect(lead.getByText('matches the receipt')).toBeVisible();
});

test('no venue on the photo: asked once before Review bill; the name typed is saved', async ({ browser }) => {
  const api = new FakeApi({ venue: null });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Where was this?' })).toBeVisible();
  await lead.getByLabel('Restaurant').fill('The Dog & Partridge');
  await lead.getByRole('button', { name: 'Done' }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByText(/^The Dog & Partridge · 5 items/)).toBeVisible();
  await expect(lead.getByLabel('Where was this?')).toHaveCount(0);
  expect(api.bill.venue?.name).toBe('The Dog & Partridge');
});

test('#65 no venue, skipped: not asked again in this tab; a “Where was this?” field on Review bill saves it', async ({ browser }) => {
  const api = new FakeApi({ venue: null });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await lead.getByRole('button', { name: 'Skip' }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await lead.reload();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Add venue' })).toHaveCount(0);
  await expect(lead.getByRole('button', { name: 'Change venue' })).toHaveCount(0);

  const field = lead.getByLabel('Where was this?');
  await expect(field).toBeVisible();
  await expect(field).toHaveAccessibleDescription('Not on the photo. Shown to everyone.');
  await field.fill('The Dog & Partridge');
  await field.press('Enter');

  await expect(lead.getByText(/^The Dog & Partridge · 5 items/)).toBeVisible();
  await expect(lead.getByLabel('Where was this?')).toHaveCount(0);
  await expect(lead.getByRole('button', { name: 'Change venue' })).toBeVisible();
  expect(api.bill.venue?.name).toBe('The Dog & Partridge');
});

test('#65 the “Where was this?” field saves when it’s left, and an empty one saves nothing', async ({ browser }) => {
  const api = new FakeApi({ venue: null });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await lead.getByRole('button', { name: 'Skip' }).click();
  const field = lead.getByLabel('Where was this?');
  await field.focus();
  await field.blur();
  await expect(field).toBeVisible();
  expect(api.bill.venue?.name).toBeUndefined();

  await field.fill('Gusto');
  await field.blur();
  await expect(lead.getByText(/^Gusto · 5 items/)).toBeVisible();
  expect(api.bill.venue?.name).toBe('Gusto');
});

test('#107 lines the reader was unsure of are checked one at a time, then Review bill', async ({ browser }) => {
  const unsure = items.map((it, i) => (i === 1 ? { ...it, unsure: 'price faded' } : i === 3 ? { ...it, unsure: 'quantity unclear' } : it));
  const api = new FakeApi({ items: unsure });
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Check this' })).toBeVisible();
  await expect(lead.getByText('price faded · 1 of 2')).toBeVisible();
  await expect(lead.getByLabel('Item')).toHaveValue('Calamari');
  await lead.getByLabel('Price each').fill('23.50');
  await lead.getByRole('button', { name: 'Looks right' }).click();

  await expect(lead.getByText('quantity unclear · 2 of 2')).toBeVisible();
  await expect(lead.getByLabel('Item')).toHaveValue('Negroni');
  await lead.getByRole('button', { name: 'Looks right' }).click();

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  // Saved once: the fix is on the bill and the reader's notes are gone.
  expect(api.items[1]).toMatchObject({ name: 'Calamari', unitPricePence: 2350 });
  expect(api.items.some((it) => it.unsure)).toBe(false);
  await lead.reload();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
});

test('a venue the lead sets beats the parsed one, shown with a change link', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, `/confirm-bill/${api.bill.billId}`);

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible();
  await expect(lead.getByText('Gennaro')).toBeVisible();
  // One row: the name, never a second row with the address under it.
  await expect(lead.getByText('12 King Street, Manchester')).toHaveCount(0);

  await lead.getByRole('button', { name: 'Change venue' }).click();
  await lead.getByLabel('Venue').fill('The Dog & Partridge');
  await lead.getByRole('button', { name: 'Done' }).click();

  await expect(lead.getByText('The Dog & Partridge')).toBeVisible();
  await expect(lead.getByText('Gennaro')).toHaveCount(0);
});

test('parse errors say what went wrong', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, '/');
  const snap = async () => {
    await lead.locator('input[capture]').setInputFiles(PHOTO);
    await lead.getByRole('button', { name: 'Use photo' }).click();
  };

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Bedrock: TimeoutError' });
  await snap();
  await expect(lead.getByText('Couldn’t reach the bill reader.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Bedrock: AccessDeniedException', details: { status: 403 } });
  await snap();
  await expect(lead.getByText('The bill reader turned us away. Not the photo’s fault.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'PARSE_FAILED', message: 'Bedrock output failed schema validation' });
  await snap();
  await expect(lead.getByText('Couldn’t read that one.')).toBeVisible({ timeout: 15_000 });

  api.faults.push({ kind: 'parse', code: 'IMAGE_TOO_LARGE', message: 'too big' });
  await snap();
  await expect(lead.getByText('That photo is too big.')).toBeVisible({ timeout: 15_000 });

  // #94: the API crashed mid-read. Not the photo's fault; e2e builds are
  // local, so it names what broke and points at the API terminal.
  api.faults.push({ kind: 'parse', code: 'INTERNAL_ERROR', message: 'Reading the bill failed', details: { errorName: 'CredentialsProviderError' } });
  await snap();
  await expect(lead.getByText('Something went wrong on our side.')).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByText('CredentialsProviderError. Check the API terminal, then try again.')).toBeVisible();
});

test('leave while the bill is read: Bills shows it, and coming back opens Review bill', async ({ browser }) => {
  const api = new FakeApi();
  api.holdReads = true;
  const lead = await diner(browser, api, users.lead, '/');

  await lead.locator('input[capture]').setInputFiles(PHOTO);

  await lead.getByRole('button', { name: 'Use photo' }).click();
  await expect(lead.getByRole('heading', { name: 'Reading your bill' })).toBeVisible({ timeout: 15_000 });
  await lead.getByRole('link', { name: 'Back to bills' }).click();

  await expect(lead.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await expect(lead.getByRole('link', { name: /Reading your bill/ })).toBeVisible();

  api.holdReads = false;
  await expect(lead.getByRole('link', { name: /Bill read/ })).toBeVisible({ timeout: 10_000 });
  await lead.getByRole('link', { name: /Bill read/ }).click();
  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
});

test('a slow read keeps the photo, and Try again reads it', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead, '/');

  api.faults.push({ kind: 'parse', code: 'PARSE_TIMEOUT', message: 'Bedrock took too long to read the bill' });
  await lead.locator('input[capture]').setInputFiles(PHOTO);
  await lead.getByRole('button', { name: 'Use photo' }).click();
  await expect(lead.getByRole('heading', { name: 'That took too long.' })).toBeVisible({ timeout: 15_000 });
  await expect(lead.getByRole('img', { name: 'Your bill' })).toBeVisible();

  await lead.getByRole('button', { name: 'Try again' }).click();

  await expect(lead.getByRole('heading', { name: 'Review bill' })).toBeVisible({ timeout: 15_000 });
});

test('fixing the bill mid-session: a picking guest and a sent guest both see the new price', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  const tom = await diner(browser, api, users.tom);

  await sam.getByRole('button', { name: 'Claim Lasagne' }).click();
  await sam.getByRole('link', { name: 'Continue to payment' }).click();
  await sam.getByRole('button', { name: 'I’ve paid' }).click();
  await sam.getByRole('dialog', { name: 'Are you sure you’ve paid?' }).getByRole('button', { name: 'Yes, I’ve paid' }).click();
  await expect(sam.getByText('Callum will confirm')).toBeVisible();
  await expect(tom.getByText('Lasagne')).toBeVisible();

  await lead.getByRole('link', { name: 'Edit bill' }).click();
  await expect(lead.getByRole('heading', { name: 'Fix the bill' })).toBeVisible();
  await lead.getByRole('button', { name: 'Edit Lasagne' }).click();
  await lead.getByLabel('Price each').fill('19.00');
  await lead.getByRole('button', { name: 'Done' }).click();
  // Edits save themselves when the editor closes.
  await expect(lead.getByRole('button', { name: 'No changes' })).toBeVisible();
  await lead.getByRole('link', { name: 'Bill', exact: true }).click();
  await expect(lead.getByRole('button', { name: 'Close bill' })).toBeVisible();

  await expect(sam.getByText('£19.00').first()).toBeVisible(POLL);
  await expect(tom.getByText('£19.00').first()).toBeVisible(POLL);
});

test('deleting the bill ends it for everyone at the table', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  const sam = await diner(browser, api, users.sam);
  await expect(sam.getByRole('heading', { name: 'What did you have?' })).toBeVisible();

  await lead.getByRole('button', { name: 'Delete this bill' }).click();
  await expect(lead.getByRole('dialog')).toContainText('1 person loses their picks');
  await lead.getByRole('dialog').getByRole('button', { name: 'Delete bill' }).click();
  await expect(lead).toHaveURL(/\/$/);
  await expect(sam.getByRole('heading', { name: 'This bill was deleted' })).toBeVisible(POLL);
  await expect(sam.getByText('Callum deleted it.')).toBeVisible();
});

test('closing with everything claimed and paid: the dialog says so and "your part" adds up', async ({ browser }) => {
  // Lead has Olives (4.25). Sam takes everything else and pays.
  const api = new FakeApi();
  api.join(users.sam);
  const sam = api.participants[1]!;
  sam.claimedItemIds = [items[1]!.itemId, items[2]!.itemId, items[3]!.itemId, items[3]!.itemId, items[4]!.itemId, items[4]!.itemId, items[4]!.itemId];
  sam.payment = { status: 'succeeded', paymentId: 'pay-u-sam', paidAt: '2026-10-31T12:30:00Z' };
  const lead = await diner(browser, api, users.lead);

  await expect(lead.getByText('Paid', { exact: true })).toBeVisible();
  await expect(lead.getByRole('button', { name: /^Not claimed/ })).toHaveCount(0);
  await lead.getByRole('button', { name: 'Close bill' }).click();
  await expect(lead.getByRole('dialog')).toContainText('Everyone has paid.');
  await lead.getByRole('dialog').getByRole('button', { name: 'Close bill' }).click();
    await expect(lead.getByText('Bill closed')).toBeVisible();
  // Sam owed 22.50 + 17.25 + 21.00 + 39.00 = 99.75; bill is 104.00; your part = 4.25.
  await expect(lead.getByText('£99.75').first()).toBeVisible();
  await expect(lead.locator('.totals__line', { hasText: 'Your part' })).toContainText('£4.25');
});

test('the lead’s QR page shows people as they arrive', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);
  await lead.getByRole('link', { name: 'QR code' }).click();
  const table = lead.getByRole('list', { name: 'At the table' });
  await expect(table).toContainText('You');
  await expect(lead.getByText('People appear here as they join.')).toBeVisible();
  api.join(users.sam);
  await expect(table).toContainText('Sam', POLL);
  await expect(lead.getByText('At the table · 2')).toBeVisible();
});

test('anyone at the table can email themselves a report of the bill', async ({ browser }) => {
  const api = new FakeApi({ status: 'claiming' });
  const lead = await diner(browser, api, users.lead);
  const email = lead.getByRole('button', { name: 'Email me a report of this bill' });
  await expect(email).toBeVisible(POLL);
  await email.click();
  await expect(lead.getByRole('button', { name: 'Report emailed to you' })).toBeDisabled();
  expect(api.reportsTo).toEqual(['u-lead']);

  const sam = await diner(browser, api, users.sam);
  await sam.getByRole('button', { name: 'Email me a report of this bill' }).click();
  await expect(sam.getByRole('button', { name: 'Report emailed to you' })).toBeVisible();
  expect(api.reportsTo).toEqual(['u-lead', 'u-sam']);
});

test('#64: the lead says how many are eating and sees "n of m joined"; once everyone is in, unclaimed items are flagged', async ({ browser }) => {
  const api = new FakeApi();
  const lead = await diner(browser, api, users.lead);

  // Unset by default: no count, no flag.
  await expect(lead.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(lead.getByText('Everyone’s here')).toHaveCount(0);

  await lead.getByRole('button', { name: 'How many eating?' }).click();
  const sheet = lead.getByRole('dialog', { name: 'How many eating?' });
  await sheet.getByRole('button', { name: 'More people' }).click(); // 2 → 3
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(lead.getByRole('heading', { name: 'People · 1 of 3 joined' })).toBeVisible();
  expect(api.requests.find((r) => r.method === 'PATCH')?.body).toBe('{"expectedDiners":3}');

  // Guests join; the count follows on the poll.
  await diner(browser, api, users.sam);
  await expect(lead.getByRole('heading', { name: 'People · 2 of 3 joined' })).toBeVisible(POLL);
  await expect(lead.getByText('Everyone’s here')).toHaveCount(0);
  await diner(browser, api, users.tom);
  await expect(lead.getByRole('heading', { name: 'People · 3 of 3 joined' })).toBeVisible(POLL);
  await expect(lead.getByText('Everyone’s here')).toBeVisible();

  // Change it, then clear it.
  await lead.getByRole('button', { name: 'Change number' }).click();
  await lead.getByRole('button', { name: 'More people' }).click();
  await lead.getByRole('button', { name: 'Save' }).click();
  await expect(lead.getByRole('heading', { name: 'People · 3 of 4 joined' })).toBeVisible();
  await expect(lead.getByText('Everyone’s here')).toHaveCount(0);
  await lead.getByRole('button', { name: 'Change number' }).click();
  await lead.getByRole('button', { name: 'Not sure' }).click();
  await expect(lead.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  expect(api.expectedDiners).toBeUndefined();
});
