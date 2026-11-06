/**
 * fast-check generators for bills and sessions, shared by the core and API
 * property tests (the API imports this file by relative path). Ids are
 * UUIDs, as in production.
 */
import fc from 'fast-check';

export type GenItem = { itemId: string; name: string; unitPricePence: number; quantity: number; category: 'food' | 'drink' };
export type GenShare = { itemId: string; userIds: string[]; ways: number; units: number; activity: [] };
export type GenParticipant = { userId: string; displayName: string; claimedItemIds: string[]; sharedItemIds: string[] };
export type GenBill = {
  billId: string;
  items: GenItem[];
  subtotalPence: number;
  serviceChargePence: number;
  taxPence: number;
  /** Shared discounts (8 Nov 2026), never more than the items. */
  discounts: { name: string; amountPence: number }[];
  totalPence: number;
};
export type GenSession = { participants: GenParticipant[]; shares: GenShare[] };

export const pence = (max = 20_000) => fc.integer({ min: 1, max });

/** 1..max distinct UUIDs. */
export const userIds = (max = 10) => fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: max });

/** A split: price, the people in it (sorted or not) and its number of ways (≥ people). */
export const split = () =>
  fc
    .record({
      price: pence(),
      members: fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 10 }),
      extraWays: fc.integer({ min: 0, max: 4 }),
    })
    .map(({ price, members, extraWays }) => ({ price, members, ways: members.length + extraWays }));

type ItemPlan = {
  price: number;
  quantity: number;
  shared: boolean;
  // Indexes into the participant list, reduced modulo its length.
  picks: number[];
};

const itemPlan = fc.record({
  price: pence(),
  quantity: fc.integer({ min: 1, max: 6 }),
  shared: fc.boolean(),
  picks: fc.array(fc.nat(), { minLength: 6, maxLength: 12 }),
});

/**
 * A bill whose every unit is either claimed or in a full split, plus the
 * session that claims it. With `complete: false`, some units are left
 * unclaimed and some splits have open spots.
 */
export const billAndSession = ({ complete = true }: { complete?: boolean } = {}) =>
  fc
    .record({
      people: userIds(10),
      plans: fc.array(itemPlan, { minLength: 1, maxLength: 15 }),
      itemIds: fc.uniqueArray(fc.uuid(), { minLength: 15, maxLength: 15 }),
      servicePct: fc.integer({ min: 0, max: 20 }),
      taxPence: fc.integer({ min: 0, max: 3_000 }),
      // Half the bills have a shared discount, up to the whole of the items.
      discountPct: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100 })),
      gaps: complete ? fc.constant([] as boolean[]) : fc.array(fc.boolean(), { minLength: 15, maxLength: 15 }),
    })
    .map(({ people, plans, itemIds, servicePct, taxPence, discountPct, gaps }) => {
      const participants: GenParticipant[] = people.map((userId, i) => ({
        userId,
        displayName: `Diner ${i + 1}`,
        claimedItemIds: [],
        sharedItemIds: [],
      }));
      const shares: GenShare[] = [];
      const items: GenItem[] = plans.map((plan: ItemPlan, i) => {
        const itemId = itemIds[i]!;
        const leaveGap = gaps[i] ?? false;
        // A split covers `units` of its line; the rest is claimed one at a time.
        if (plan.shared && people.length > 1) {
          const units = 1 + (plan.picks[1]! % plan.quantity);
          const ways = 2 + (plan.picks[0]! % (people.length - 1));
          const members = [...new Set(plan.picks.map((n) => people[n % people.length]!))].slice(0, ways);
          // Fill the split from the front of the list if picks repeated.
          for (const p of people) if (members.length < ways && !members.includes(p)) members.push(p);
          const taken = leaveGap ? members.slice(0, Math.max(1, members.length - 1)) : members;
          shares.push({ itemId, userIds: taken, ways, units, activity: [] });
          for (const uid of taken) participants.find((p) => p.userId === uid)!.sharedItemIds.push(itemId);
          for (let u = 0; u < plan.quantity - units; u++) {
            participants[plan.picks[(u + 2) % plan.picks.length]! % people.length]!.claimedItemIds.push(itemId);
          }
          return { itemId, name: `Item ${i + 1}`, unitPricePence: plan.price, quantity: plan.quantity, category: 'food' };
        }
        const claimed = leaveGap ? plan.quantity - 1 : plan.quantity;
        for (let u = 0; u < claimed; u++) {
          participants[plan.picks[u % plan.picks.length]! % people.length]!.claimedItemIds.push(itemId);
        }
        return { itemId, name: `Item ${i + 1}`, unitPricePence: plan.price, quantity: plan.quantity, category: 'drink' };
      });
      const subtotalPence = items.reduce((acc, it) => acc + it.unitPricePence * it.quantity, 0);
      const serviceChargePence = Math.round((subtotalPence * servicePct) / 100);
      const off = Math.floor((subtotalPence * discountPct) / 100);
      const bill: GenBill = {
        billId: '00000000-0000-4000-8000-000000000000',
        items,
        subtotalPence,
        serviceChargePence,
        taxPence,
        discounts: off > 0 ? [{ name: 'Loyalty discount', amountPence: off }] : [],
        totalPence: subtotalPence + serviceChargePence + taxPence - off,
      };
      const session: GenSession = { participants, shares };
      return { bill, session };
    });
