import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Session, Participant } from '../types/sessions.js';

const SESSION_TTL_DAYS = 30;

const sessionPk = (sessionId: string) => `SESS#${sessionId}`;
const META_SK = 'META';
const partSk = (userId: string) => `PART#${userId}`;
const codePk = (code: string) => `JCODE#${code}`;
const billLockPk = (billId: string) => `BILLLOCK#${billId}`;

type SessionMetaRow = Omit<Session, 'participants'> & { pk: string; sk: string };

const ttlEpochSeconds = (): number =>
  Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

export const sessionStore = {
  /**
   * Atomically create the session metadata + the join-code index. The code
   * write is conditional (no overwrite) so collisions surface as ConditionalCheckFailed.
   */
  async create(session: Session): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    const { participants: _participants, ...meta } = session;
    const metaRow: SessionMetaRow = {
      pk: sessionPk(session.sessionId),
      sk: META_SK,
      ...meta,
      ttlAt: new Date(ttlAt * 1000).toISOString(),
    };

    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Put: { TableName: TABLE_NAME, Item: metaRow } },
      ...session.participants.map((p) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: { pk: sessionPk(session.sessionId), sk: partSk(p.userId), ttlAt, ...p },
        },
      })),
    ];

    if (session.joinCode) {
      transactItems.push({
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: codePk(session.joinCode),
            sk: codePk(session.joinCode),
            sessionId: session.sessionId,
            ttlAt,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }

    // Lock the bill to this session for the entire session lifetime so the
    // bill cannot be amended while in use. Released on abandon.
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          pk: billLockPk(session.billId),
          sk: billLockPk(session.billId),
          sessionId: session.sessionId,
          lockedAt: new Date().toISOString(),
          ttlAt,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  async get(sessionId: string): Promise<Session | null> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': sessionPk(sessionId) },
        ConsistentRead: true,
      }),
    );
    if (!result.Items || result.Items.length === 0) return null;

    let meta: Omit<Session, 'participants'> | null = null;
    const participants: Participant[] = [];

    for (const raw of result.Items) {
      const { pk: _pk, sk, ...rest } = raw;
      if (sk === META_SK) {
        meta = rest as Omit<Session, 'participants'>;
      } else if (typeof sk === 'string' && sk.startsWith('PART#')) {
        participants.push(rest as Participant);
      }
    }

    if (!meta) return null;
    return { ...meta, participants };
  },

  async resolveJoinCode(code: string): Promise<{ sessionId: string } | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: codePk(code), sk: codePk(code) },
      }),
    );
    if (!result.Item) return null;
    return { sessionId: result.Item.sessionId as string };
  },

  /**
   * Replace a participant's full record (claims, payment, etc.).
   * Used for joins and claim updates.
   */
  async putParticipant(sessionId: string, participant: Participant): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: sessionPk(sessionId),
          sk: partSk(participant.userId),
          ttlAt: ttlEpochSeconds(),
          ...participant,
        },
      }),
    );
  },

  /**
   * Update only the session metadata row (status, etc.). Participants are
   * separate rows and updated by `putParticipant`.
   */
  async putMeta(meta: Omit<Session, 'participants'>): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: sessionPk(meta.sessionId),
          sk: META_SK,
          ttlAt: ttlEpochSeconds(),
          ...meta,
        },
      }),
    );
  },

  /**
   * Atomically transition setup → claiming: write the updated meta row
   * with status='claiming' AND the updated creator participant row
   * (payment.status = 'self_paid', claims frozen) in one TransactWrite.
   */
  async applyShare(input: {
    sessionMeta: Omit<Session, 'participants'>;
    creator: Participant;
  }): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: sessionPk(input.sessionMeta.sessionId),
                sk: META_SK,
                ttlAt,
                ...input.sessionMeta,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: sessionPk(input.sessionMeta.sessionId),
                sk: partSk(input.creator.userId),
                ttlAt,
                ...input.creator,
              },
            },
          },
        ],
      }),
    );
  },

  /**
   * Apply lock-claims atomically: write all participant rows with their
   * computed owedPence + the meta row in `paying` state. The bill lock
   * is already in place from session-create.
   */
  async applyLockClaims(input: {
    sessionMeta: Omit<Session, 'participants'>;
    participants: Participant[];
  }): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            pk: sessionPk(input.sessionMeta.sessionId),
            sk: META_SK,
            ttlAt,
            ...input.sessionMeta,
          },
        },
      },
      ...input.participants.map((p) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: { pk: sessionPk(input.sessionMeta.sessionId), sk: partSk(p.userId), ttlAt, ...p },
        },
      })),
    ];
    // Bill lock is already in place from session create; no need to write again.

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  async getBillLock(billId: string): Promise<{ sessionId: string } | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: billLockPk(billId), sk: billLockPk(billId) },
      }),
    );
    if (!result.Item) return null;
    return { sessionId: result.Item.sessionId as string };
  },

  async deleteBillLock(billId: string): Promise<void> {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { pk: billLockPk(billId), sk: billLockPk(billId) },
            },
          },
        ],
      }),
    );
  },
};
