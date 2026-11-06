import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * WhatsApp state (#230):
 * - `WAWIN#{e164}` / `WIN`: when the person last messaged us. Replies are
 *   free-form and free for 24 hours after it (Meta's customer-service window).
 * - `WAMSG#{messageId}` / `SEEN`: inbound messages already handled (Meta
 *   retries webhooks), kept 2 days.
 * - `WATPL#{yyyy-mm}` / `COUNT`: paid template sends this month, capped.
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
const day = 24 * 60 * 60;
const nowS = () => Math.floor(Date.now() / 1000);

export const whatsappStore = {
  async openWindow(e164: string, at: Date): Promise<void> {
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `WAWIN#${e164}`, sk: 'WIN' },
          // Webhooks can arrive out of order: keep the latest.
          UpdateExpression: 'SET lastInboundAt = :at, ttlAt = :ttl',
          ConditionExpression: 'attribute_not_exists(lastInboundAt) OR lastInboundAt < :at',
          ExpressionAttributeValues: {
            ':at': at.toISOString(),
            ':ttl': Math.floor(at.getTime() / 1000) + 2 * day,
          },
        }),
      )
      .catch((err: unknown) => {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      });
  },

  /** True while a free-form reply is allowed (with a minute's margin). */
  async windowOpen(e164: string, now = new Date()): Promise<boolean> {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: `WAWIN#${e164}`, sk: 'WIN' } }),
    );
    const at = res.Item?.lastInboundAt as string | undefined;
    return !!at && now.getTime() - new Date(at).getTime() < WINDOW_MS - 60_000;
  },

  /** `false` if this message id was seen before. */
  async firstSight(messageId: string): Promise<boolean> {
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { pk: `WAMSG#${messageId}`, sk: 'SEEN', ttlAt: nowS() + 2 * day },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  },

  /** Counts one paid template send this month; `false` once `cap` is reached. */
  async countTemplate(cap: number, now = new Date()): Promise<boolean> {
    const month = now.toISOString().slice(0, 7);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `WATPL#${month}`, sk: 'COUNT' },
          UpdateExpression: 'SET sends = if_not_exists(sends, :zero) + :one, ttlAt = :ttl',
          ConditionExpression: 'attribute_not_exists(sends) OR sends < :cap',
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':cap': cap,
            ':ttl': nowS() + 400 * day,
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  },
};
