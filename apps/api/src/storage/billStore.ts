import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { batchGetAll, ddb, TABLE_NAME } from './ddb.js';
import { sessionStore } from './sessionStore.js';
import type { Bill } from '../types/bills.js';
import type { Participant, Session, ShareSettings } from '../types/sessions.js';

const SESSION_TTL_DAYS = 30;
const ttlEpochSeconds = (): number =>
  Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

const billPk = (billId: string) => `BILL#${billId}`;
const versionSk = (n: number) => `V#${String(n).padStart(3, '0')}`;
const LATEST_SK = 'LATEST';
const hashPk = (userId: string, sha256: string) => `IMGHASH#${userId}#${sha256}`;
const sessionPk = (sessionId: string) => `SESS#${sessionId}`;
const META_SK = 'META';
const partSk = (userId: string) => `PART#${userId}`;

/** What GET /v1/me/sessions reads of a bill version. */
export type SummaryBill = Pick<
  Bill,
  'items' | 'subtotalPence' | 'serviceChargePence' | 'taxPence' | 'totalPence'
>;
export const summaryBillKey = (billId: string, versionNumber: number): string =>
  `${billId}#${versionNumber}`;
export const summarySplitKey = (sessionId: string, itemId: string): string =>
  `${sessionId}#${itemId}`;

export const billStore = {
  /**
   * Atomically writes a new version row AND updates the LATEST mirror.
   * If indexImageHash is provided, also writes the image-hash index in the
   * same transaction (used on initial parse, not on amendment).
   */
  async putVersion(
    bill: Bill,
    opts?: { indexImageHash?: { userId: string; sha256: string } },
  ): Promise<void> {
    const item = {
      pk: billPk(bill.billId),
      ...bill,
    };
    const versionItem = { ...item, sk: versionSk(bill.versionNumber) };
    const latestItem = { ...item, sk: LATEST_SK };

    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Put: { TableName: TABLE_NAME, Item: versionItem } },
      { Put: { TableName: TABLE_NAME, Item: latestItem } },
    ];
    if (opts?.indexImageHash) {
      const { userId, sha256 } = opts.indexImageHash;
      transactItems.push({
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: hashPk(userId, sha256),
            sk: hashPk(userId, sha256),
            billId: bill.billId,
          },
        },
      });
    }

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  async getLatest(billId: string): Promise<Bill | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: billPk(billId), sk: LATEST_SK },
      }),
    );
    if (!result.Item) return null;
    return stripKeys(result.Item) as Bill;
  },

  async getVersion(billId: string, versionNumber: number): Promise<Bill | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: billPk(billId), sk: versionSk(versionNumber) },
      }),
    );
    if (!result.Item) return null;
    return stripKeys(result.Item) as Bill;
  },

  /**
   * For the list of a user's sessions (GET /v1/me/sessions): the pinned
   * bill versions and the split rows the caller is in, in one BatchGet,
   * with only what the money maths needs.
   */
  async getVersionsAndSplits(input: {
    bills: ReadonlyArray<{ billId: string; versionNumber: number }>;
    splits: ReadonlyArray<{ sessionId: string; itemId: string }>;
  }): Promise<{
    bills: Map<string, SummaryBill>;
    splits: Map<string, ShareSettings>;
  }> {
    const keys = new Map<string, { pk: string; sk: string }>();
    for (const b of input.bills) {
      const key = { pk: billPk(b.billId), sk: versionSk(b.versionNumber) };
      keys.set(`${key.pk}|${key.sk}`, key);
    }
    for (const s of input.splits) {
      const key = { pk: sessionPk(s.sessionId), sk: `SHARE#${s.itemId}` };
      keys.set(`${key.pk}|${key.sk}`, key);
    }
    const bills = new Map<string, SummaryBill>();
    const splits = new Map<string, ShareSettings>();
    if (keys.size === 0) return { bills, splits };
    const names = [
      'pk',
      'sk',
      'items',
      'subtotalPence',
      'serviceChargePence',
      'taxPence',
      'totalPence',
      'itemId',
      'ways',
      'units',
      'userIds',
      'version',
    ];
    const rows = await batchGetAll([...keys.values()], {
      expression: names.map((n) => `#${n}`).join(', '),
      names: Object.fromEntries(names.map((n) => [`#${n}`, n])),
    });
    for (const row of rows) {
      const { pk, sk, ...rest } = row as { pk: string; sk: string };
      if (pk.startsWith('BILL#')) {
        bills.set(
          summaryBillKey(pk.slice('BILL#'.length), Number(sk.slice(2))),
          rest as SummaryBill,
        );
      } else if (pk.startsWith('SESS#')) {
        splits.set(summarySplitKey(pk.slice('SESS#'.length), sk.slice('SHARE#'.length)), {
          activity: [],
          ...rest,
        } as unknown as ShareSettings);
      }
    }
    return { bills, splits };
  },

  async findByImageHash(userId: string, sha256: string): Promise<{ billId: string } | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: hashPk(userId, sha256), sk: hashPk(userId, sha256) },
      }),
    );
    if (!result.Item) return null;
    return { billId: result.Item.billId as string };
  },

  /**
   * Atomic mid-session amend: writes the new bill version (V# + LATEST) AND
   * the reconciled session meta + participant rows in one TransactWrite.
   * Used when the lead amends a bill that's currently pinned to an active
   * session — the session's pinnedBillVersion bumps and stale claims/ready
   * flags are pruned in lockstep.
   */
  async applyAmendWithSession(input: {
    bill: Bill;
    sessionMeta: Omit<Session, 'participants'>;
    participants: Participant[];
    /** Items removed from the bill whose split settings rows go too. */
    removedSplitItemIds?: string[];
  }): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    const billItem = { pk: billPk(input.bill.billId), ...input.bill };
    // Shares and split settings have their own rows and are merged in on
    // read; they must never land in the META row (a stale copy there would
    // shadow the real rows). The session passed in comes from a read, so
    // strip them here.
    const {
      shares: _shares,
      shareSettings: _shareSettings,
      ...meta
    } = input.sessionMeta as Omit<Session, 'participants'> & {
      shares?: unknown;
      shareSettings?: unknown;
    };
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: { ...billItem, sk: versionSk(input.bill.versionNumber) },
        },
      },
      { Put: { TableName: TABLE_NAME, Item: { ...billItem, sk: LATEST_SK } } },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: sessionPk(input.sessionMeta.sessionId),
            sk: META_SK,
            ...meta,
            ttlAt,
          },
        },
      },
      ...input.participants.map((p) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: { pk: sessionPk(input.sessionMeta.sessionId), sk: partSk(p.userId), ttlAt, ...p },
        },
      })),
      ...(input.removedSplitItemIds ?? []).map((itemId) => ({
        Delete: {
          TableName: TABLE_NAME,
          Key: { pk: sessionPk(input.sessionMeta.sessionId), sk: `SHARE#${itemId}` },
        },
      })),
      // Claims read before this amend must not land against the old bill.
      sessionStore.bumpClaimsVersionOp(input.sessionMeta.sessionId),
    ];
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  async indexImageHash(userId: string, sha256: string, billId: string): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: hashPk(userId, sha256),
          sk: hashPk(userId, sha256),
          billId,
        },
      }),
    );
  },
};

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}
