import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { TableFee, TableFeeStore } from '../services/billing/tableFee.js';

const feePk = (billId: string) => `FEE#${billId}`;
const FEE_SK = 'FEE';

/** One row per bill: the lead's paid table fee, and its refund if any. Kept as a tax record, so no TTL. */
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
          // New, or replacing a refunded fee with a fresh payment. A
          // resent webhook for the refunded payment itself writes nothing.
          ConditionExpression:
            'attribute_not_exists(pk) OR (attribute_exists(refundedAt) AND checkoutSessionId <> :cs)',
          ExpressionAttributeValues: { ':cs': fee.checkoutSessionId },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async markRefunded(billId, refund) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: feePk(billId), sk: FEE_SK },
          UpdateExpression: 'SET refundId = :id, refundedAt = :at',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(refundedAt)',
          ExpressionAttributeValues: { ':id': refund.refundId, ':at': refund.refundedAt },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },
};
