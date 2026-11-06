'use client';

/**
 * #219: the "Stop reminders" link in a reminder text. Opening it stops them
 * for this bill (a named sender can't take STOP replies). No sign-in.
 */
import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useStopReminders } from '@gdp/core/api/hooks/useTexts';
import { Button, Centre, Notice, Spinner } from '@/components/ui';

export default function StopRemindersPage() {
  const { token } = useParams<{ token: string }>();
  const stop = useStopReminders();
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || !token) return;
    asked.current = true;
    stop.mutate(token);
  }, [token, stop]);

  if (stop.isSuccess) {
    return (
      <Centre>
        <Notice tone="ok" title="No more reminders for this bill." />
        <Button tone="secondary" href={`/b/${token}`}>See the bill</Button>
      </Centre>
    );
  }
  if (stop.isError) {
    const gone = stop.error instanceof ApiError && stop.error.status === 404;
    return (
      <Centre>
        <Notice tone={gone ? 'info' : 'error'} title={gone ? 'This link has expired.' : 'Couldn’t stop reminders.'}>
          {gone ? 'There are no more reminders for this bill.' : <Button tone="secondary" onClick={() => stop.mutate(token)}>Try again</Button>}
        </Notice>
      </Centre>
    );
  }
  return <Centre><Spinner /></Centre>;
}
