import { z } from 'zod';

/** #218: a bill's comments. Text only, short. */
export const COMMENT_MAX_CHARS = 280;

export const PostCommentRequestSchema = z.object({
  text: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(COMMENT_MAX_CHARS)),
});
export type PostCommentRequest = z.infer<typeof PostCommentRequestSchema>;

export interface Comment {
  commentId: string;
  userId: string;
  displayName: string;
  text: string;
  createdAt: string;
}
