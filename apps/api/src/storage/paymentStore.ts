import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Payment } from '../types/payments.js';
import type { Participant } from '../types/sessions.js';
import { sessionStore } from './sessionStore.js';

const SESSION_TTL_DAYS = 30;

const paymentPk = (paymentId: string) => `PAY#${paymentId}`;

const ttlEpochSeconds = (): number =>
  Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

// Rows written before TrueLayer was removed also carry GSI2PK, provider
// and providerPaymentId; drop them so every payment reads the same.
const stripKeys = (item: Record<string, unknown>): Record<string, unknown> => {
  const {
    pk: _pk,
    sk: _sk,
    GSI2PK: _gsi,
    provider: _provider,
    providerPaymentId: _providerPaymentId,
    ...rest
  } = item;
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

  /**
   * Atomically update a payment's status and the matching participant row.
   * Used at initiate and on confirm so the two views can never disagree.
   * Fails with ConditionalCheckFailed if the participant changed since read.
   */
  async applyUpdate(input: { payment: Payment; participant: Participant }): Promise<void> {
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: paymentPk(input.payment.paymentId),
            sk: paymentPk(input.payment.paymentId),
            ...input.payment,
          },
        },
      },
      // Conditional on the row being as it was read, so a claim (or the
      // lead's confirm) landing in between isn't overwritten: the whole
      // transaction fails and the caller re-reads.
      sessionStore.participantPutOp(input.payment.sessionId, ttlEpochSeconds(), input.participant),
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
};
