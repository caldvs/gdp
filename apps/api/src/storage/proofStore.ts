import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { ProofRow } from '../types/proofs.js';

/**
 * #226: proof-of-payment screenshots, in the session's own item collection
 * (`SESS#{id}` / `PROOF#{userId}#{proofId}`). The rows expire after 30
 * days, like the S3 objects under `proofs/` (bucket lifecycle rule).
 */
const PROOF_TTL_DAYS = 30;
const sk = (userId: string, proofId: string) => `PROOF#${userId}#${proofId}`;

export const proofKey = (sessionId: string, userId: string, proofId: string): string =>
  `proofs/${sessionId}/${userId}/${proofId}.jpg`;

const view = (raw: Record<string, unknown>): ProofRow => {
  const r = raw as unknown as ProofRow;
  return {
    proofId: r.proofId,
    userId: r.userId,
    createdAt: r.createdAt,
    ...(r.sentAt ? { sentAt: r.sentAt } : {}),
  };
};

export const proofStore = {
  async put(sessionId: string, row: ProofRow): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `SESS#${sessionId}`,
          sk: sk(row.userId, row.proofId),
          ...row,
          ttlAt: Math.floor(Date.now() / 1000) + PROOF_TTL_DAYS * 24 * 60 * 60,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },

  async markSent(sessionId: string, userId: string, proofId: string, at: string): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `SESS#${sessionId}`, sk: sk(userId, proofId) },
        UpdateExpression: 'SET sentAt = if_not_exists(sentAt, :at)',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':at': at },
      }),
    );
  },

  /** One guest's, or everyone's when `userId` is absent. Oldest first. */
  async list(sessionId: string, userId?: string): Promise<ProofRow[]> {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: {
          ':pk': `SESS#${sessionId}`,
          ':p': userId ? `PROOF#${userId}#` : 'PROOF#',
        },
      }),
    );
    return (res.Items ?? []).map(view);
  },

  async delete(sessionId: string, userId: string, proofId: string): Promise<boolean> {
    const res = await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: `SESS#${sessionId}`, sk: sk(userId, proofId) },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return !!res.Attributes;
  },
};
