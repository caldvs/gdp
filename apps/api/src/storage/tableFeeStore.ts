import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { TableFee, TableFeeStore } from '../services/billing/tableFee.js';

const feePk = (billId: string) => `FEE#${billId}`;
const FEE_SK = 'FEE';

/** One row per bill: the lead's paid table fee. Kept as a tax record, so no TTL. */
export const tableFeeStore: TableFeeStore = {
  async get(billId) {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: feePk(billId), sk: FEE_SK } }),
    );
    if (!result.Item) return null;
    const { pk: _pk, sk: _sk, ...fee } = result.Item;
    return fee as TableFee;
  },

  async putIfAbsent(fee) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { pk: feePk(fee.billId), sk: FEE_SK, ...fee },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },
};
