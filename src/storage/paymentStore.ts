import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Payment } from '../types/payments.js';
import type { Participant } from '../types/sessions.js';

const SESSION_TTL_DAYS = 30;

const paymentPk = (paymentId: string) => `PAY#${paymentId}`;
const sessionPk = (sessionId: string) => `SESS#${sessionId}`;
const partSk = (userId: string) => `PART#${userId}`;
const provIdx = (providerPaymentId: string) => `PROVPAY#${providerPaymentId}`;
const userIdx = (userId: string) => `USER#${userId}`;

const ttlEpochSeconds = (): number =>
  Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

const stripKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const { pk: _pk, sk: _sk, GSI2PK: _gsi, ...rest } = item;
  return rest;
};

export const paymentStore = {
  async put(payment: Payment): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: paymentPk(payment.paymentId),
          sk: paymentPk(payment.paymentId),
          GSI2PK: provIdx(payment.providerPaymentId),
          ...payment,
        },
      }),
    );
  },

  async get(paymentId: string): Promise<Payment | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: paymentPk(paymentId), sk: paymentPk(paymentId) },
      }),
    );
    if (!result.Item) return null;
    return stripKeys(result.Item) as Payment;
  },

  async findByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': provIdx(providerPaymentId) },
        Limit: 1,
      }),
    );
    if (!result.Items || result.Items.length === 0) return null;
    return stripKeys(result.Items[0]!) as Payment;
  },

  /**
   * Atomically update a payment's status and the matching participant row.
   * Used both at initiate-time (pending → registered) and on every webhook
   * event so the two views can never disagree.
   */
  async applyUpdate(input: { payment: Payment; participant: Participant }): Promise<void> {
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: paymentPk(input.payment.paymentId),
            sk: paymentPk(input.payment.paymentId),
            GSI2PK: provIdx(input.payment.providerPaymentId),
            ...input.payment,
          },
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: sessionPk(input.payment.sessionId),
            sk: partSk(input.participant.userId),
            ttlAt: ttlEpochSeconds(),
            // sessionStore.get strips GSI1PK/GSI1SK on read, so we have to
            // re-add them here or this Put silently drops the participant
            // from the byUser index — breaking listForUser for that diner.
            GSI1PK: userIdx(input.participant.userId),
            GSI1SK: input.payment.sessionId,
            ...input.participant,
          },
        },
      },
    ];
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  /**
   * Atomically set Payment.payerClaimedPaidAt with `if_not_exists`, so two
   * concurrent claims both end up with the same canonical timestamp (the
   * one that won the race). Returns the updated payment with the canonical
   * timestamp set. If the payment row doesn't exist, throws.
   */
  async setPayerClaimedPaidAt(paymentId: string, ts: string): Promise<Payment> {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: paymentPk(paymentId), sk: paymentPk(paymentId) },
        UpdateExpression: 'SET payerClaimedPaidAt = if_not_exists(payerClaimedPaidAt, :ts)',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':ts': ts },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys(res.Attributes ?? {}) as Payment;
  },

  /**
   * Mirror the canonical claim timestamp onto the participant's payment
   * subdocument. Conditioned on the participant still being in `pending`
   * status — if they've moved to succeeded/failed since, the mirror is a
   * no-op (the row is the truth, not the mirror).
   */
  async setParticipantPayerClaimedPaidAt(input: {
    sessionId: string;
    userId: string;
    ts: string;
  }): Promise<void> {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: sessionPk(input.sessionId), sk: partSk(input.userId) },
          UpdateExpression:
            'SET payment.payerClaimedPaidAt = if_not_exists(payment.payerClaimedPaidAt, :ts)',
          ConditionExpression: 'payment.#st = :pending',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':ts': input.ts, ':pending': 'pending' },
        }),
      );
    } catch (err) {
      // ConditionalCheckFailedException = participant moved past pending; that's fine.
      if (
        err instanceof Error &&
        (err.name === 'ConditionalCheckFailedException' ||
          (err as { name?: string }).name === 'ConditionalCheckFailedException')
      ) {
        return;
      }
      throw err;
    }
  },
};
