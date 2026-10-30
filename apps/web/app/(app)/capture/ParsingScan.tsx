'use client';

import { useEffect, useState } from 'react';

/**
 * Loading state for the capture flow: the lead's own photo with a soft band
 * of light pulsing across it, and a spinner with one line of status text.
 */

type Phase = 'processing' | 'parsing';

const MESSAGES: Record<Phase | 'slow', string[]> = {
  processing: ['Getting your photo ready'],
  parsing: ['Reading the items', 'Working out the prices', 'Adding it up'],
  slow: ['Long bill? This one is taking a little longer'],
};

export function ParsingScan({ phase, photoUrl, stillWorking }: { phase: Phase; photoUrl?: string; stillWorking: boolean }) {
  const messages = MESSAGES[phase === 'parsing' && stillWorking ? 'slow' : phase];
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
    if (messages.length < 2) return;
    // Step through once and stay on the last message rather than looping.
    const t = setInterval(() => setIdx((i) => Math.min(i + 1, messages.length - 1)), 2800);
    return () => clearInterval(t);
  }, [messages]);

  return (
    <div className="scan" aria-busy="true">
      <div className="scan__frame">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt="" className="scan__photo" />
        ) : (
          <div className="scan__paper" aria-hidden />
        )}
        <div className="scan__sheen" aria-hidden />
      </div>

      <div className="scan__status">
        <span className="spinner" aria-hidden />
        <p key={messages[idx]} className="scan__msg" role="status">{messages[idx]}</p>
      </div>
    </div>
  );
}
