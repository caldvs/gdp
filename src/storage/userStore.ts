import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { PayoutAccount, User } from '../types/users.js';

const userPk = (userId: string) => `USER#${userId}`;

interface UserRow extends User {
  pk: string;
  sk: string;
}

export const userStore = {
  async get(userId: string): Promise<User | null> {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: userPk(userId), sk: userPk(userId) },
      }),
    );
    if (!res.Item) return null;
    const { pk: _pk, sk: _sk, ...rest } = res.Item as UserRow;
    return rest;
  },

  /**
   * Create or update the basic profile fields (email, displayName, etc.)
   * on a user row without disturbing other fields like payoutAccount.
   * Used on first successful OTP verify to seed the row.
   */
  async putProfile(input: {
    userId: string;
    email: string;
    displayName: string;
    avatarUrl?: string;
  }): Promise<User> {
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: userPk(input.userId), sk: userPk(input.userId) },
        UpdateExpression:
          'SET email = :email, displayName = :name, updatedAt = :now, userId = if_not_exists(userId, :uid), createdAt = if_not_exists(createdAt, :now)' +
          (input.avatarUrl ? ', avatarUrl = :avatar' : ''),
        ExpressionAttributeValues: {
          ':email': input.email,
          ':name': input.displayName,
          ':now': now,
          ':uid': input.userId,
          ...(input.avatarUrl ? { ':avatar': input.avatarUrl } : {}),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const { pk: _pk, sk: _sk, ...rest } = (res.Attributes ?? {}) as UserRow;
    return rest;
  },

  /**
   * Idempotently set the payout account on a user row, creating the row if
   * it doesn't exist. We use UpdateCommand rather than Put so that other
   * fields populated later (e.g. captured profile data) aren't clobbered.
   */
  async setPayoutAccount(userId: string, payoutAccount: PayoutAccount): Promise<User> {
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: userPk(userId), sk: userPk(userId) },
        UpdateExpression:
          'SET payoutAccount = :pa, updatedAt = :now, userId = if_not_exists(userId, :uid), createdAt = if_not_exists(createdAt, :now)',
        ExpressionAttributeValues: {
          ':pa': payoutAccount,
          ':now': now,
          ':uid': userId,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const { pk: _pk, sk: _sk, ...rest } = (res.Attributes ?? {}) as UserRow;
    return rest;
  },
};
