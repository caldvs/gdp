/** The tables the page stories sit at, built on the e2e suite's in-memory API. */
import { FakeCore, SID, items, users } from '../../e2e/fakeCore';
import { as } from '../fakeFetch';

export { BID, CODE, SID, items, users } from '../../e2e/fakeCore';

/** Four at Gennaro: Sam says he's paid, Priya has, Tom's still picking. */
export function busyTable() {
  const api = new FakeCore({ serviceRate: 0.125 });
  api.join({ userId: 'u-sam', displayName: 'Sam Patel', email: 'sam@example.com' });
  api.join({ userId: 'u-priya', displayName: 'Priya Shah', email: 'priya@example.com' });
  api.join({ userId: 'u-tom', displayName: 'Tom Reid', email: 'tom@example.com' });
  const [, sam, priya] = api.participants;
  sam!.claimedItemIds = [items[2]!.itemId, items[3]!.itemId];
  sam!.payment = { status: 'pending', paymentId: 'pay-u-sam', payerClaimedPaidAt: '2026-10-31T12:30:00Z' };
  priya!.claimedItemIds = [items[4]!.itemId];
  priya!.payment = { status: 'succeeded', paymentId: 'pay-u-priya', paidAt: '2026-10-31T12:20:00Z' };
  return api;
}

/** Just shared: the lead and two friends who've only just sat down. */
export function newTable() {
  const api = new FakeCore({ serviceRate: 0.125 });
  api.join({ userId: 'u-sam', displayName: 'Sam Patel', email: 'sam@example.com' });
  api.join({ userId: 'u-priya', displayName: 'Priya Shah', email: 'priya@example.com' });
  return api;
}

/** Priya and Tom are splitting the calamari three ways with room for one more. */
export function splittingTable() {
  const api = busyTable();
  const [, , priya, tom] = api.participants;
  api.shares.push({ itemId: items[1]!.itemId, userIds: ['u-priya', 'u-tom'], ways: 3, activity: [] });
  priya!.sharedItemIds = [items[1]!.itemId];
  tom!.sharedItemIds = [items[1]!.itemId];
  return api;
}

/** The lead's bills: one open, three closed. */
export function withBills(api = busyTable()) {
  const base = { creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: 'b', pinnedBillVersion: 1 };
  const day = 864e5;
  api.mySessions = [
    { ...base, sessionId: SID, status: 'claiming', role: 'lead', venue: { name: 'Gennaro' }, createdAt: new Date().toISOString(), myPaymentStatus: 'self_paid' },
    { ...base, sessionId: 's2', status: 'settled', role: 'diner', venue: { name: 'Dishoom' }, createdAt: new Date(Date.now() - day).toISOString(), myPaymentStatus: 'succeeded', billTotalPence: 9600, mySharePence: 2840 },
    { ...base, sessionId: 's3', status: 'settled', role: 'lead', venue: { name: 'Bundobust' }, createdAt: new Date(Date.now() - 5 * day).toISOString(), myPaymentStatus: 'self_paid', billTotalPence: 14250, mySharePence: 3100 },
    { ...base, sessionId: 's4', status: 'settled', role: 'diner', venue: { name: 'Rudy’s' }, createdAt: new Date(Date.now() - 9 * day).toISOString(), myPaymentStatus: 'succeeded', billTotalPence: 6200, mySharePence: 1550 },
  ];
  return api;
}

/**
 * Gennaro, mid-meal, set up by acting as each diner: Priya's paid and the
 * lead marked it received, Sam says he has, Tom has the calamari but hasn't
 * paid, two Espresso Martinis unclaimed.
 */
export function midMeal(opts: { leadClaims?: string[] } = {}) {
  const [, calamari, lasagne, negroni, martini] = items.map((i) => i.itemId) as [string, string, string, string, string];
  const path = (p: string) => `/v1/sessions/${SID}${p}`;
  const api = new FakeCore({ serviceRate: 0.125, ...(opts.leadClaims ? { leadClaims: opts.leadClaims } : {}) });
  api.expectedDiners = 4;
  for (const u of [users.sam, users.tom, users.priya]) api.join(u);
  const sam = as(api, users.sam);
  as(api, users.tom).post(path('/claims'), { claimedItemIds: [calamari] });
  sam.post(path('/claims'), { claimedItemIds: [lasagne, negroni] });
  as(api, users.priya).post(path('/claims'), { claimedItemIds: [negroni, martini] });
  const opened = sam.post(path('/payments')) as { payment: { paymentId: string } };
  sam.post(`/v1/payments/${opened.payment.paymentId}/mark-paid`);
  as(api, users.lead).post(path(`/participants/${users.priya.userId}/received`));
  return api;
}

/** midMeal, closed by the lead. */
export function closedTable() {
  const api = midMeal();
  as(api, users.lead).post(`/v1/sessions/${SID}/close`);
  return api;
}
