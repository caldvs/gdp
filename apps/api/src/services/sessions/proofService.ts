import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uuidv7 } from '../../lib/uuid.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { proofKey, proofStore } from '../../storage/proofStore.js';
import { countInWindow } from '../../storage/rateCounter.js';
import { s3, BILLS_BUCKET } from '../../storage/s3.js';
import type { VerifiedCaller } from '../../context/caller.js';
import { PROOFS_PER_GUEST, type ProofView } from '../../types/proofs.js';

const URL_TTL_SECONDS = 300;
const STARTS_PER_HOUR = 10;

/**
 * #226: a guest's screenshot of their payment, for the lead only. The
 * browser crops and re-encodes it (no EXIF) before it's uploaded; we never
 * log it or put it in an email. A screenshot isn't payment: the lead still
 * marks it received.
 */
async function load(caller: VerifiedCaller, sessionId: string) {
  const session = await sessionStore.get(sessionId);
  const me = session?.participants.find((p) => p.userId === caller.userId);
  if (!session || !me) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  return { session, me, isLead: session.creatorUserId === caller.userId };
}

const notFound = () => new AppError('NOT_FOUND', 'Screenshot not found');

export const proofService = {
  /** A presigned PUT for one cropped JPEG. Guests only, while the bill is live. */
  async start(input: { caller: VerifiedCaller; sessionId: string; sizeBytes: number }) {
    const { session, isLead } = await load(input.caller, input.sessionId);
    if (isLead) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.status === 'abandoned' || session.status === 'setup') {
      throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}`);
    }
    const mine = await proofStore.list(input.sessionId, input.caller.userId);
    if (mine.length >= PROOFS_PER_GUEST) {
      throw new AppError('RATE_LIMITED', 'That’s enough screenshots for this bill.');
    }
    const allowed = await countInWindow(
      `PROOFRATE#${input.sessionId}#${input.caller.userId}`,
      60 * 60,
      STARTS_PER_HOUR,
    );
    if (!allowed.ok) {
      throw new AppError('RATE_LIMITED', 'Too many tries. Wait a while.', {
        retryAfterSeconds: allowed.retryAfterSeconds,
      });
    }
    const proofId = uuidv7();
    await proofStore.put(input.sessionId, {
      proofId,
      userId: input.caller.userId,
      createdAt: new Date().toISOString(),
    });
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: proofKey(input.sessionId, input.caller.userId, proofId),
        ContentType: 'image/jpeg',
        ContentLength: input.sizeBytes,
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
    return {
      proofId,
      url,
      expiresAt: new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString(),
    };
  },

  /** The upload landed: the lead can see it now. */
  async sent(input: {
    caller: VerifiedCaller;
    sessionId: string;
    proofId: string;
    /** #221: tell the lead, the first time this screenshot is sent. */
    onFirstSent?: (sessionId: string, guestName: string) => Promise<void>;
  }) {
    const { me } = await load(input.caller, input.sessionId);
    const row = (await proofStore.list(input.sessionId, input.caller.userId)).find(
      (p) => p.proofId === input.proofId,
    );
    if (!row) throw notFound();
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: BILLS_BUCKET,
          Key: proofKey(input.sessionId, input.caller.userId, input.proofId),
        }),
      );
    } catch {
      throw new AppError('SESSION_INVALID_STATE', 'The screenshot hasn’t uploaded yet');
    }
    const at = row.sentAt ?? new Date().toISOString();
    await proofStore.markSent(input.sessionId, input.caller.userId, input.proofId, at);
    if (!row.sentAt) await input.onFirstSent?.(input.sessionId, me.displayName);
    return this.viewOf(input.sessionId, { ...row, sentAt: at });
  },

  /** The lead sees everyone's; a guest sees their own. Sent ones only. */
  async list(input: { caller: VerifiedCaller; sessionId: string }): Promise<ProofView[]> {
    const { isLead } = await load(input.caller, input.sessionId);
    const rows = await proofStore.list(input.sessionId, isLead ? undefined : input.caller.userId);
    return Promise.all(rows.filter((r) => r.sentAt).map((r) => this.viewOf(input.sessionId, r)));
  },

  async remove(input: { caller: VerifiedCaller; sessionId: string; proofId: string }) {
    await load(input.caller, input.sessionId);
    const gone = await proofStore.delete(input.sessionId, input.caller.userId, input.proofId);
    if (!gone) throw notFound();
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: proofKey(input.sessionId, input.caller.userId, input.proofId),
      }),
    );
  },

  async viewOf(
    sessionId: string,
    row: { proofId: string; userId: string; sentAt?: string },
  ): Promise<ProofView> {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: proofKey(sessionId, row.userId, row.proofId),
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
    return { proofId: row.proofId, userId: row.userId, sentAt: row.sentAt ?? '', url };
  },
};
