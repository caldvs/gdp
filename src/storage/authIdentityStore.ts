import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

const pk = (email: string) => `AUTH#email:${email.toLowerCase()}`;

export interface AuthIdentity {
  email: string;
  userId: string;
  createdAt: string;
}

/**
 * Maps an email to an opaque userId. Decouples user identity from any
 * specific auth provider — if/when we add Apple Sign-In or social
 * providers later, each lookup row (`AUTH#email:...`, `AUTH#apple:...`)
 * can point at the same userId so the same person stays the same user
 * across providers.
 */
export const authIdentityStore = {
  async getByEmail(email: string): Promise<AuthIdentity | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(email), sk: pk(email) },
      }),
    );
    if (!result.Item) return null;
    return {
      email: result.Item.email as string,
      userId: result.Item.userId as string,
      createdAt: result.Item.createdAt as string,
    };
  },

  async putByEmail(identity: AuthIdentity): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(identity.email),
          sk: pk(identity.email),
          email: identity.email,
          userId: identity.userId,
          createdAt: identity.createdAt,
        },
      }),
    );
  },
};
