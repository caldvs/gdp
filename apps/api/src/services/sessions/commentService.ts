import { uuidv7 } from '../../lib/uuid.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { commentStore } from '../../storage/commentStore.js';
import { countInWindow } from '../../storage/rateCounter.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Comment } from '../../types/comments.js';

/** Per person per bill: plenty for a conversation, not for a flood. */
const COMMENTS_PER_HOUR = 30;

/** #218: anyone at the table reads and writes; nobody else sees the bill exists. */
async function participantOf(caller: VerifiedCaller, sessionId: string) {
  const session = await sessionStore.get(sessionId);
  const me = session?.participants.find((p) => p.userId === caller.userId);
  if (!session || !me) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  return { session, me };
}

export const commentService = {
  async list(input: { caller: VerifiedCaller; sessionId: string }): Promise<Comment[]> {
    await participantOf(input.caller, input.sessionId);
    return commentStore.list(input.sessionId);
  },

  async post(input: { caller: VerifiedCaller; sessionId: string; text: string }): Promise<Comment> {
    const { session, me } = await participantOf(input.caller, input.sessionId);
    if (session.status === 'abandoned') {
      throw new AppError('SESSION_INVALID_STATE', 'This bill was deleted');
    }
    const allowed = await countInWindow(
      `COMMENTRATE#${input.sessionId}#${input.caller.userId}`,
      60 * 60,
      COMMENTS_PER_HOUR,
    );
    if (!allowed.ok) {
      throw new AppError('RATE_LIMITED', 'Too many comments. Wait a while.', {
        retryAfterSeconds: allowed.retryAfterSeconds,
      });
    }
    const comment: Comment = {
      commentId: uuidv7(),
      userId: me.userId,
      displayName: me.displayName,
      text: input.text,
      createdAt: new Date().toISOString(),
    };
    await commentStore.put(input.sessionId, comment);
    return comment;
  },
};
