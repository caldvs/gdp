'use client';

/**
 * #218: the bill's comments, on the lead's bill (L5) and the guest's
 * Waiting screen (G4). Oldest first, name and time, polled every 5s.
 * Text only: never turned into links, no images (keeps bank details and
 * screenshots out).
 */
import { useState, type FormEvent } from 'react';
import { useComments, usePostComment } from '@gdp/core/api/hooks/useComments';
import { Button, Section, firstName } from '@/components/ui';

const MAX = 280;

export function Comments({ sessionId, meUserId, closed }: { sessionId: string; meUserId: string; closed?: boolean }) {
  const comments = useComments(sessionId);
  const post = usePostComment(sessionId);
  const [text, setText] = useState('');
  const list = comments.data ?? [];

  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || post.isPending) return;
    post.mutate({ text: t }, { onSuccess: () => setText('') });
  };

  return (
    <Section title="Comments">
      {list.length > 0 ? (
        <ol className="comments" aria-label="Comments" aria-live="polite">
          {list.map((c) => (
            <li key={c.commentId} className={`comment${c.userId === meUserId ? ' comment--me' : ''}`}>
              <span className="comment__who">
                <b>{c.userId === meUserId ? 'You' : firstName(c.displayName, 'Someone')}</b>
                <time dateTime={c.createdAt}>{timeOf(c.createdAt)}</time>
              </span>
              <span className="comment__text">{c.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">Nothing yet.</p>
      )}
      {closed ? null : (
        <form className="comment-form" onSubmit={send}>
          <label htmlFor={`c-${sessionId}`} className="vh">Write a comment</label>
          <input
            id={`c-${sessionId}`}
            className="input"
            value={text}
            maxLength={MAX}
            placeholder="Write a comment"
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" small busy={post.isPending} disabled={!text.trim()}>Send</Button>
        </form>
      )}
      {post.isError ? <p className="field__err" role="alert">{post.error.message}</p> : null}
    </Section>
  );
}

/** "19:42" today; "Sat 19:42" otherwise. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}
