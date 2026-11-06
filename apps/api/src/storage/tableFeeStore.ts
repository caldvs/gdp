import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type {
  CreditStore,
  SavedCard,
  SavedCardStore,
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
/**
 * A hold spent on a share, waiting to be taken or released (#168): one row
 * per bill, on GSI1 partition `HOLDS` sorted by when the hold was placed,
 * so the daily sweep finds old ones without a scan.
 */
const holdQPk = (billId: string) => `HOLDQ#${billId}`;
const HOLDQ_SK = 'HOLDQ';
const HOLDS_IDX = 'HOLDS';

/** A hold the daily sweep should look at. */
export interface PendingHold {
  billId: string;
  sessionId: string;
  heldAt: string;
}

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
      (existing.refundedAt || existing.releasedAt || existing.sessionId)
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
          // New; or a fresh payment replacing a refunded fee, a released
          // hold, or one already spent on a share. A resent webhook for the
          // same payment writes nothing.
          ConditionExpression:
            'attribute_not_exists(pk) OR (checkoutSessionId <> :cs AND (attribute_exists(refundedAt) OR attribute_exists(releasedAt) OR attribute_exists(sessionId)))',
          ExpressionAttributeValues: { ':cs': fee.checkoutSessionId },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async markReleased(billId, releasedAt) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: feePk(billId), sk: FEE_SK },
          UpdateExpression: 'SET releasedAt = :at',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(releasedAt)',
          ExpressionAttributeValues: { ':at': releasedAt },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async markCaptured(billId, capture) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: feePk(billId), sk: FEE_SK },
          UpdateExpression: 'SET capturedPence = :p, capturedAt = :at',
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(capturedAt) AND attribute_not_exists(releasedAt)',
          ExpressionAttributeValues: { ':p': capture.capturedPence, ':at': capture.capturedAt },
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async markCharge(billId, charge) {
    // A charge is decided once; one that needed confirming can then succeed.
    const condition =
      charge.chargeStatus === 'charged'
        ? 'attribute_exists(pk) AND (attribute_not_exists(chargeStatus) OR chargeStatus = :needs)'
        : 'attribute_exists(pk) AND attribute_not_exists(chargeStatus)';
    const sets = ['chargeStatus = :st', 'chargePence = :p'];
    const values: Record<string, unknown> = {
      ':st': charge.chargeStatus,
      ':p': charge.chargePence,
    };
    if (charge.chargeStatus === 'charged') values[':needs'] = 'needs_confirming';
    if (charge.chargeIntentId) {
      sets.push('chargeIntentId = :pi');
      values[':pi'] = charge.chargeIntentId;
    }
    if (charge.chargedAt) {
      sets.push('chargedAt = :at');
      values[':at'] = charge.chargedAt;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: feePk(billId), sk: FEE_SK },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeValues: values,
        }),
      );
      return 'recorded';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  },

  async setChargeIntent(billId, chargeIntentId) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: feePk(billId), sk: FEE_SK },
        UpdateExpression: 'SET chargeIntentId = :pi',
        ConditionExpression: 'chargeStatus = :needs',
        ExpressionAttributeValues: { ':pi': chargeIntentId, ':needs': 'needs_confirming' },
      }),
    );
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

const cardPk = (userId: string) => `CARD#${userId}`;
const CARD_SK = 'CARD';

/**
 * #228: the lead's Stripe customer and the card saved with their last hold,
 * one row per lead. Only Stripe ids and what the card shows (brand, last
 * four): no card data. Removing the card keeps the customer.
 */
export const savedCardStore: SavedCardStore = {
  async get(userId) {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: cardPk(userId), sk: CARD_SK } }),
    );
    return result.Item ? strip<SavedCard>(result.Item) : null;
  },

  async put(card) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: cardPk(card.userId), sk: CARD_SK, ...card },
      }),
    );
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

/** Holds spent on shares and not yet seen settled by the sweep (#168). */
export const holdIndex = {
  async list(): Promise<PendingHold[]> {
    const out: PendingHold[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': HOLDS_IDX },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of page.Items ?? []) out.push(strip<PendingHold>(item));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return out;
  },

  async clear(billId: string): Promise<void> {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: holdQPk(billId), sk: HOLDQ_SK } }),
    );
  },
};

/**
 * The transaction step that spends an entitlement on a share, so the
 * session can't go to `claiming` without it (and two shares can't spend
 * one fee or one credit).
 */
export const entitlementOps = (entitlement: ShareEntitlement): TransactItem[] => {
  if (entitlement.kind === 'waived') return [];
  if (entitlement.kind === 'fee') {
    const spend: TransactItem = {
      Update: {
        TableName: TABLE_NAME,
        Key: { pk: feePk(entitlement.billId), sk: FEE_SK },
        UpdateExpression: 'SET sessionId = :sid',
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(refundedAt) AND attribute_not_exists(releasedAt) AND (attribute_not_exists(sessionId) OR sessionId = :sid)',
        ExpressionAttributeValues: { ':sid': entitlement.sessionId },
      },
    };
    if (!entitlement.holdPence) return [spend];
    // A hold: put it where the daily sweep looks (#168).
    const heldAt = entitlement.heldAt ?? new Date().toISOString();
    return [
      spend,
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: holdQPk(entitlement.billId),
            sk: HOLDQ_SK,
            GSI1PK: HOLDS_IDX,
            GSI1SK: heldAt,
            billId: entitlement.billId,
            sessionId: entitlement.sessionId,
            heldAt,
          },
        },
      },
    ];
  }
  const c = entitlement.credit;
  return [
    {
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
    },
  ];
};
