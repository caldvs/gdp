import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Bill } from '../types/bills.js';

const billPk = (billId: string) => `BILL#${billId}`;
const versionSk = (n: number) => `V#${String(n).padStart(3, '0')}`;
const LATEST_SK = 'LATEST';
const hashPk = (userId: string, sha256: string) => `IMGHASH#${userId}#${sha256}`;

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
