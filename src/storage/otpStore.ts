import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

const OTP_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

const pk = (email: string) => `OTP#email:${email.toLowerCase()}`;

export interface OtpRecord {
  email: string; // original casing for the email "to" field
  codeHash: string; // sha256 hex of the plaintext code
  attempts: number;
  createdAt: string; // ISO timestamp, for logs / debugging
  ttlAt: number; // epoch seconds, DDB TTL
}

export const otpStore = {
  /**
   * Replace any existing OTP for this email with a fresh one. There's only
   * ever one active code per email at a time — issuing a new one
   * invalidates the previous, which is the natural "I didn't get the
   * email, send me another" behaviour.
   */
  async put(email: string, codeHash: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(email),
          sk: pk(email),
          email,
          codeHash,
          attempts: 0,
          createdAt: new Date().toISOString(),
          ttlAt: now + OTP_TTL_SECONDS,
        },
      }),
    );
  },

  async get(email: string): Promise<OtpRecord | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(email), sk: pk(email) },
      }),
    );
    if (!result.Item) return null;
    const now = Math.floor(Date.now() / 1000);
    // DDB TTL deletion is eventual (~48h). Treat as expired ourselves
    // immediately past the deadline.
    if ((result.Item.ttlAt as number) <= now) return null;
    // Lock out once the attempt cap is hit — even a correct code after
    // that point must fail. Caller treats null the same as "no record"
    // so the response is uniform with the not-found case.
    const attempts = (result.Item.attempts as number) ?? 0;
    if (attempts >= MAX_ATTEMPTS) return null;
    return {
      email: result.Item.email as string,
      codeHash: result.Item.codeHash as string,
      attempts,
      createdAt: result.Item.createdAt as string,
      ttlAt: result.Item.ttlAt as number,
    };
  },

  /**
   * Atomically increment the attempts counter. Returns the new count, or
   * `null` if the row is gone (expired / consumed) or has hit the cap.
   * Callers should treat `null` the same as "wrong code" to avoid leaking
   * the existence/state of an OTP for the email.
   */
  async tryIncrementAttempt(email: string): Promise<number | null> {
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: pk(email), sk: pk(email) },
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression: 'attribute_exists(pk) AND attempts < :max',
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': MAX_ATTEMPTS,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return (out.Attributes?.attempts as number) ?? null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return null;
      }
      throw err;
    }
  },

  /** Invalidate after a successful verify, or after hitting the attempt cap. */
  async invalidate(email: string): Promise<void> {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(email), sk: pk(email) },
      }),
    );
  },

  // Exposed for callers that want to surface the policy in error messages
  // or rate-limit responses.
  MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
};
