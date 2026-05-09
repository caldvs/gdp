import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Payment } from '../types/payments.js';
import type { Participant } from '../types/sessions.js';

const paymentPk = (paymentId: string) => `PAY#${paymentId}`;
const sessionPk = (sessionId: string) => `SESS#${sessionId}`;
const partSk = (userId: string) => `PART#${userId}`;
const provIdx = (providerPaymentId: string) => `PROVPAY#${providerPaymentId}`;

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
            ...input.participant,
          },
        },
      },
    ];
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },
};
