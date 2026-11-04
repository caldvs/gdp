import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type {
  CreditStore,
  MonthlyCredit,
  ShareEntitlement,
  TableFee,
  TableFeeStore,
} from '../services/billing/tableFee.js';

const feePk = (billId: string) => `FEE#${billId}`;
const FEE_SK = 'FEE';
/** A fee replaced by a newer payment for the same bill, kept as a tax record. */
const replacedFeeSk = (checkoutSessionId: string) => `FEE#${checkoutSessionId}`;
const creditPk = (userId: string, month: string) => `CREDIT#${userId}#${month}`;
const CREDIT_SK = 'CREDIT';
/** GSI1 partition for a lead's fees and credits (the account page). */
const feesIdx = (userId: string) => `FEES#${userId}`;

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const strip = <T>(item: Record<string, unknown>): T => {
  const { pk: _pk, sk: _sk, GSI1PK: _g, GSI1SK: _gs, ...rest } = item;
  return rest as T;
};

/**
 * One row per bill: the lead's paid table fee, its refund if any, and the
 * session it paid for. Kept as a tax record, so no TTL; a fee replaced by a
 * new payment (after a refund, or once spent on an earlier share) moves to
 * `FEE#<checkoutSessionId>` under the same bill.
 */
export const tableFeeStore: TableFeeStore = {
  async get(billId) {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: feePk(billId), sk: FEE_SK } }),
    );
    return result.Item ? strip<TableFee>(result.Item) : null;
  },

  async putIfAbsent(fee) {
    const existing = await tableFeeStore.get(fee.billId);
    if (
      existing &&
      existing.checkoutSessionId !== fee.checkoutSessionId &&
      (existing.refundedAt || existing.sessionId)
    ) {
      // Keep the old payment before the new one takes its place. Writing
      // it twice is harmless.
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: feePk(existing.billId),
            sk: replacedFeeSk(existing.checkoutSessionId),
            GSI1PK: feesIdx(existing.userId),
            GSI1SK: existing.paidAt,
            ...existing,
          },
        }),
      );
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: feePk(fee.billId),
            sk: FEE_SK,
            GSI1PK: feesIdx(fee.userId),
            GSI1SK: fee.paidAt,
            ...fee,
          },
          // New; or a fresh payment replacing a refunded fee or one already
          // spent on a share. A resent webhook for the same payment writes nothing.
          ConditionExpression:
            'attribute_not_exists(pk) OR (checkoutSessionId <> :cs AND (attribute_exists(refundedAt) OR attribute_exists(sessionId)))',
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

/** The lead's free bill each month: `CREDIT#<userId>#<yyyy-mm>`, no TTL (a small record per lead per month). */
export const creditStore: CreditStore = {
  async get(userId, month) {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: creditPk(userId, month), sk: CREDIT_SK },
      }),
    );
    return result.Item ? strip<MonthlyCredit>(result.Item) : null;
  },

  async markReturned(userId, month, sessionId, returnedAt) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: creditPk(userId, month), sk: CREDIT_SK },
          UpdateExpression: 'SET returnedAt = :at',
          ConditionExpression:
            'attribute_exists(pk) AND sessionId = :sid AND attribute_not_exists(returnedAt)',
          ExpressionAttributeValues: { ':at': returnedAt, ':sid': sessionId },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async listForUser(userId) {
    const fees: TableFee[] = [];
    const credits: MonthlyCredit[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': feesIdx(userId) },
          ScanIndexForward: false,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        const pk = String(item.pk);
        if (pk.startsWith('FEE#')) fees.push(strip<TableFee>(item));
        else if (pk.startsWith('CREDIT#')) credits.push(strip<MonthlyCredit>(item));
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return { fees, credits };
  },
};

/**
 * The transaction step that spends an entitlement on a share, so the
 * session can't go to `claiming` without it (and two shares can't spend
 * one fee or one credit).
 */
export const entitlementOp = (entitlement: ShareEntitlement): TransactItem | null => {
  if (entitlement.kind === 'waived') return null;
  if (entitlement.kind === 'fee') {
    return {
      Update: {
        TableName: TABLE_NAME,
        Key: { pk: feePk(entitlement.billId), sk: FEE_SK },
        UpdateExpression: 'SET sessionId = :sid',
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(refundedAt) AND (attribute_not_exists(sessionId) OR sessionId = :sid)',
        ExpressionAttributeValues: { ':sid': entitlement.sessionId },
      },
    };
  }
  const c = entitlement.credit;
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: {
        pk: creditPk(c.userId, c.month),
        sk: CREDIT_SK,
        GSI1PK: feesIdx(c.userId),
        GSI1SK: c.claimedAt,
        userId: c.userId,
        month: c.month,
        billId: c.billId,
        sessionId: c.sessionId,
        claimedAt: c.claimedAt,
      },
      // Unclaimed this month, already this session's, or handed back.
      ConditionExpression:
        'attribute_not_exists(pk) OR sessionId = :sid OR attribute_exists(returnedAt)',
      ExpressionAttributeValues: { ':sid': c.sessionId },
    },
  };
};
