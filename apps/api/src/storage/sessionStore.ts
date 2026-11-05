import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import type { Session, Participant, ShareSettings } from '../types/sessions.js';

const SESSION_TTL_DAYS = 30;

const sessionPk = (sessionId: string) => `SESS#${sessionId}`;
const META_SK = 'META';
// One row per session counting changes to who has what (claims, splits,
// bill amends). Claim writes are conditional on it, so two claims read
// against the same state can't both land.
const CLAIMS_SK = 'CLAIMS';
const partSk = (userId: string) => `PART#${userId}`;
const shareSk = (itemId: string) => `SHARE#${itemId}`;
const codePk = (code: string) => `JCODE#${code}`;
const billLockPk = (billId: string) => `BILLLOCK#${billId}`;
const userIdx = (userId: string) => `USER#${userId}`;

// Participant row helper — every participant row carries GSI1PK so we can
// list a user's sessions via the GSI1 query. UUIDv7 sessionIds are
// time-ordered, so reverse-sort on GSI1SK gives most-recent-first for free.
function participantItem(sessionId: string, ttlAt: number, p: Participant) {
  return {
    pk: sessionPk(sessionId),
    sk: partSk(p.userId),
    ttlAt,
    GSI1PK: userIdx(p.userId),
    GSI1SK: sessionId,
    ...p,
  };
}

// Fields that live elsewhere (split settings have their own rows; shares
// are derived on read) and must never be written into the META row.
function metaOnly<T extends object>(meta: T): Omit<T, 'shares' | 'shareSettings'> {
  const {
    shares: _s,
    shareSettings: _ss,
    ...rest
  } = meta as T & { shares?: unknown; shareSettings?: unknown };
  return rest;
}

// ttlAt is DynamoDB's TTL attribute: epoch seconds, internal to storage.
type SessionMetaRow = Omit<Session, 'participants' | 'ttlAt'> & {
  pk: string;
  sk: string;
  ttlAt: number;
};

const ttlEpochSeconds = (): number =>
  Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;

/** Bump the claims version, but only from `expected` (see CLAIMS_SK). */
function claimsVersionGuardOp(
  sessionId: string,
  expected: number,
  ttlAt: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: { pk: sessionPk(sessionId), sk: CLAIMS_SK },
      UpdateExpression: 'SET #v = :next, ttlAt = :ttl',
      ConditionExpression: expected === 0 ? 'attribute_not_exists(#v)' : '#v = :expected',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: {
        ':next': expected + 1,
        ':ttl': ttlAt,
        ...(expected === 0 ? {} : { ':expected': expected }),
      },
    },
  };
}

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
      ...metaOnly(meta),
      ttlAt,
    };

    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Put: { TableName: TABLE_NAME, Item: metaRow } },
      ...session.participants.map((p) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: participantItem(session.sessionId, ttlAt, p),
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
    // bill cannot be amended while in use. Released on close and abandon.
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
    return (await this.getWithClaimsVersion(sessionId))?.session ?? null;
  },

  /**
   * The session plus the version of its claims row, read in one consistent
   * query. Pass the version to `putClaimsGuarded`.
   */
  async getWithClaimsVersion(
    sessionId: string,
  ): Promise<{ session: Session; claimsVersion: number } | null> {
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
    const shareSettings: ShareSettings[] = [];
    let claimsVersion = 0;

    for (const raw of result.Items) {
      const { pk: _pk, sk, GSI1PK: _g1pk, GSI1SK: _g1sk, ...rest } = raw;
      if (sk === META_SK) {
        // ttlAt is storage-only (epoch seconds for DynamoDB TTL).
        const { ttlAt: _ttl, ...m } = rest;
        meta = m as Omit<Session, 'participants'>;
      } else if (typeof sk === 'string' && sk.startsWith('PART#')) {
        participants.push(rest as Participant);
      } else if (typeof sk === 'string' && sk.startsWith('SHARE#')) {
        const { ttlAt: _ttl, ...settings } = rest;
        shareSettings.push(settings as ShareSettings);
      } else if (sk === CLAIMS_SK) {
        claimsVersion = Number((rest as { version?: number }).version ?? 0);
      }
    }

    if (!meta) return null;
    return {
      session: { ...meta, participants, ...(shareSettings.length > 0 && { shareSettings }) },
      claimsVersion,
    };
  },

  /**
   * Write a participant's claims only if nobody changed who-has-what since
   * `expectedVersion` was read. Fails with ConditionalCheckFailed otherwise,
   * so the caller re-reads and re-validates.
   */
  async putClaimsGuarded(
    sessionId: string,
    participant: Participant,
    expectedVersion: number,
  ): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          claimsVersionGuardOp(sessionId, expectedVersion, ttlAt),
          { Put: { TableName: TABLE_NAME, Item: participantItem(sessionId, ttlAt, participant) } },
        ],
      }),
    );
  },

  /** Transaction step that marks who-has-what as changed (see CLAIMS_SK). */
  bumpClaimsVersionOp(
    sessionId: string,
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    return {
      Update: {
        TableName: TABLE_NAME,
        Key: { pk: sessionPk(sessionId), sk: CLAIMS_SK },
        UpdateExpression: 'ADD #v :one SET ttlAt = :ttl',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttlEpochSeconds() },
      },
    };
  },

  /**
   * Whether the user is (or was) at a table for this bill: any session they
   * have a participant row in whose bill is `billId`. Used to let guests
   * keep reading a bill after its lock is released.
   */
  async userHasSessionForBill(userId: string, billId: string): Promise<boolean> {
    return (await sessionStore.sessionsForBill(userId, billId)).length > 0;
  },

  /**
   * The sessions for this bill the user has a participant row in, newest
   * first (sessionIds are UUIDv7), with who led each and its status.
   */
  async sessionsForBill(
    userId: string,
    billId: string,
  ): Promise<Array<Pick<Session, 'sessionId' | 'status' | 'creatorUserId'>>> {
    const sessionIds: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': userIdx(userId) },
          ProjectionExpression: 'GSI1SK',
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const row of page.Items ?? []) {
        if (typeof row.GSI1SK === 'string') sessionIds.push(row.GSI1SK);
      }
      start = page.LastEvaluatedKey;
    } while (start);

    const found: Array<Pick<Session, 'sessionId' | 'status' | 'creatorUserId'>> = [];
    for (let i = 0; i < sessionIds.length; i += 100) {
      const chunk = sessionIds.slice(i, i + 100);
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [TABLE_NAME]: {
              Keys: chunk.map((id) => ({ pk: sessionPk(id), sk: META_SK })),
              ProjectionExpression: 'billId, sessionId, #status, creatorUserId',
              ExpressionAttributeNames: { '#status': 'status' },
            },
          },
        }),
      );
      for (const m of res.Responses?.[TABLE_NAME] ?? []) {
        if (m.billId !== billId) continue;
        found.push({
          sessionId: m.sessionId as string,
          status: m.status as Session['status'],
          creatorUserId: m.creatorUserId as string,
        });
      }
    }
    return found.sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1));
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
        Item: participantItem(sessionId, ttlEpochSeconds(), participant),
      }),
    );
  },

  /**
   * Write a participant row together with the split settings for one
   * item, atomically. `expectedVersion` is the settings version the
   * caller read (null when there was no settings row); a concurrent
   * change to the same split fails the whole write with
   * ConditionalCheckFailed so the caller can re-read and retry.
   * `settings: null` deletes the row (last sharer left).
   */
  async applyShareChange(input: {
    sessionId: string;
    participant?: Participant;
    /** Others changed in the same step (a claim turned into a split, #130). */
    others?: Participant[];
    itemId: string;
    settings: ShareSettings | null;
    expectedVersion: number | null;
    /**
     * The claims version read with the session. Joining or leaving a split
     * changes who has what, so it must not land on top of a claim made in
     * between (see putClaimsGuarded). Omit for changes that don't (ways).
     */
    expectedClaimsVersion?: number;
  }): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    const key = { pk: sessionPk(input.sessionId), sk: shareSk(input.itemId) };
    const condition =
      input.expectedVersion === null
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: 'version = :v',
            ExpressionAttributeValues: { ':v': input.expectedVersion },
          };
    const settingsOp: NonNullable<TransactWriteCommandInput['TransactItems']>[number] =
      input.settings === null
        ? { Delete: { TableName: TABLE_NAME, Key: key, ...condition } }
        : {
            Put: {
              TableName: TABLE_NAME,
              Item: { ...key, ttlAt, ...input.settings },
              ...condition,
            },
          };
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      settingsOp,
      input.expectedClaimsVersion === undefined
        ? sessionStore.bumpClaimsVersionOp(input.sessionId)
        : claimsVersionGuardOp(input.sessionId, input.expectedClaimsVersion, ttlAt),
    ];
    if (input.participant) {
      items.push({
        Put: {
          TableName: TABLE_NAME,
          Item: participantItem(input.sessionId, ttlAt, input.participant),
        },
      });
    }
    for (const p of input.others ?? []) {
      items.push({
        Put: { TableName: TABLE_NAME, Item: participantItem(input.sessionId, ttlAt, p) },
      });
    }
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
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
          ...metaOnly(meta),
        },
      }),
    );
  },

  /**
   * Set (or with null, remove) the lead's expected party size on the META
   * row. A targeted update, so it can't overwrite anything else in the row.
   */
  async setExpectedDiners(sessionId: string, expectedDiners: number | null): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: sessionPk(sessionId), sk: META_SK },
        ConditionExpression: 'attribute_exists(pk)',
        ...(expectedDiners === null
          ? { UpdateExpression: 'REMOVE expectedDiners' }
          : {
              UpdateExpression: 'SET expectedDiners = :n',
              ExpressionAttributeValues: { ':n': expectedDiners },
            }),
      }),
    );
  },

  /** The lead's fingerprint of the bank details in their join link (#151). */
  async setPayoutCheck(sessionId: string, payoutCheck: string): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: sessionPk(sessionId), sk: META_SK },
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: 'SET payoutCheck = :c',
        ExpressionAttributeValues: { ':c': payoutCheck },
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
    /** Spends the fee or credit that pays for this share (see tableFeeStore.entitlementOps). */
    entitlement?: NonNullable<TransactWriteCommandInput['TransactItems']>;
  }): Promise<void> {
    const ttlAt = ttlEpochSeconds();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(input.entitlement ?? []),
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                pk: sessionPk(input.sessionMeta.sessionId),
                sk: META_SK,
                ttlAt,
                ...metaOnly(input.sessionMeta),
              },
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: participantItem(input.sessionMeta.sessionId, ttlAt, input.creator),
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
            ...metaOnly(input.sessionMeta),
          },
        },
      },
      ...input.participants.map((p) => ({
        Put: {
          TableName: TABLE_NAME,
          Item: participantItem(input.sessionMeta.sessionId, ttlAt, p),
        },
      })),
    ];
    // Bill lock is already in place from session create; no need to write again.

    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  },

  /**
   * List sessions where the user is a participant, most recent first. Uses
   * GSI1 (USER#{userId} → sessionId) for the index then BatchGet on the META
   * rows to assemble summaries.
   *
   * Returns lightweight summaries (sessionId, status, role, billId,
   * pinnedBillVersion, createdAt, plus the caller's owedPence and payment
   * status when available). The full Session can be fetched on demand.
   */
  async listForUser(
    userId: string,
    limit: number,
  ): Promise<
    Array<
      Omit<Session, 'participants' | 'venue'> & {
        venue?: { name: string };
        role: 'lead' | 'diner';
        myOwedPence?: number;
        myPaymentStatus: Participant['payment']['status'];
      }
    >
  > {
    const idxRes = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': userIdx(userId) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const partRows = idxRes.Items ?? [];
    if (partRows.length === 0) return [];

    const sessionIds = partRows
      .map((row) => {
        const { GSI1SK } = row as { GSI1SK?: string };
        return typeof GSI1SK === 'string' ? GSI1SK : null;
      })
      .filter((id): id is string => !!id);
    if (sessionIds.length === 0) return [];

    const metaRes = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE_NAME]: {
            Keys: sessionIds.map((id) => ({ pk: sessionPk(id), sk: META_SK })),
          },
        },
      }),
    );
    const metaBySessionId = new Map<string, Omit<Session, 'participants'>>();
    for (const raw of metaRes.Responses?.[TABLE_NAME] ?? []) {
      // ttlAt is storage-only (epoch seconds for DynamoDB TTL).
      const { pk: _pk, sk: _sk, GSI1PK: _g1pk, GSI1SK: _g1sk, ttlAt: _ttl, ...rest } = raw;
      const meta = rest as Omit<Session, 'participants'>;
      metaBySessionId.set(meta.sessionId, meta);
    }

    // Preserve the index order; drop sessions whose meta is missing
    // (TTL-expired or partial data). Augment with the caller's PART# row.
    // The full Venue lives on the stored meta; project it down to just
    // `{ name }` here so list-view consumers don't pull placeId / coords
    // they don't need (and clients can rely on the slim shape).
    const out = sessionIds
      .map((id) => {
        const meta = metaBySessionId.get(id);
        if (!meta) return null;
        const partRow = partRows.find((r) => r.GSI1SK === id) as
          (Participant & { GSI1SK?: string }) | undefined;
        const { venue: fullVenue, ...metaWithoutVenue } = meta;
        return {
          ...metaWithoutVenue,
          ...(fullVenue?.name ? { venue: { name: fullVenue.name } } : {}),
          role: meta.creatorUserId === userId ? ('lead' as const) : ('diner' as const),
          ...(partRow?.owedPence !== undefined ? { myOwedPence: partRow.owedPence } : {}),
          myPaymentStatus: partRow?.payment.status ?? ('unpaid' as const),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return out;
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
