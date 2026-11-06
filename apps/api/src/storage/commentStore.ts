import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Comment } from '../types/comments.js';

/**
 * #218: a bill's comments, in the session's own item collection
 * (`SESS#{id}` / `COMMENT#{uuidv7}`), so they expire with it (30 days).
 * UUIDv7 ids sort by time: a forward Query is oldest first.
 */
const COMMENT_TTL_DAYS = 30;
const MAX_LISTED = 200;

export const commentStore = {
  async put(sessionId: string, comment: Comment): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `SESS#${sessionId}`,
          sk: `COMMENT#${comment.commentId}`,
          ...comment,
          ttlAt: Math.floor(Date.now() / 1000) + COMMENT_TTL_DAYS * 24 * 60 * 60,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },

  /** Oldest first; at most the latest 200. */
  async list(sessionId: string): Promise<Comment[]> {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :c)',
        ExpressionAttributeValues: { ':pk': `SESS#${sessionId}`, ':c': 'COMMENT#' },
        ScanIndexForward: false,
        Limit: MAX_LISTED,
      }),
    );
    return (res.Items ?? [])
      .map(({ commentId, userId, displayName, text, createdAt }) => ({
        commentId: String(commentId),
        userId: String(userId),
        displayName: String(displayName),
        text: String(text),
        createdAt: String(createdAt),
      }))
      .reverse();
  },
};
