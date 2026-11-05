'use client';

/**
 * #198: what changed at the table since the last poll, as one line for a
 * hidden live region: who joined, and who says they've paid. The first poll
 * only records what's there. The line clears after a few seconds.
 */
import { useEffect, useRef, useState } from 'react';
import type { components } from '@gdp/core/api';
import { ledger } from '@gdp/core/lib/ledger';
import { formatGBP } from '@gdp/core/lib/money';
import { firstName } from './ui';

type Participant = components['schemas']['Participant'];
type Seen = { id: string; name: string; waiting: { id: string; pence: number }[] };

const CLEAR_MS = 5000;

/**
 * `participants` is undefined until the session has loaded. `owed`, when
 * given, also announces payments a guest says they've sent.
 */
export function useTableFeed(participants: Participant[] | undefined, hostId: string, owed?: (p: Participant) => number): string {
  const key = participants && JSON.stringify(participants
    .filter((p) => p.userId !== hostId)
    .map((p): Seen => ({
      id: p.userId,
      name: firstName(p.displayName, 'Guest'),
      waiting: owed ? ledger(p, owed(p)).waiting.map((e) => ({ id: e.paymentId, pence: e.amountPence })) : [],
    })));
  const prevRef = useRef<Map<string, Seen> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [text, setText] = useState('');

  useEffect(() => {
    if (key === undefined) return;
    const now = JSON.parse(key) as Seen[];
    const prev = prevRef.current;
    prevRef.current = new Map(now.map((p) => [p.id, p]));
    if (!prev) return;
    const said: string[] = [];
    for (const p of now) {
      const was = prev.get(p.id);
      if (!was) said.push(`${p.name} joined`);
      const known = new Set(was?.waiting.map((w) => w.id));
      for (const w of p.waiting) if (!known.has(w.id)) said.push(`${p.name} says they’ve paid ${formatGBP(w.pence)}`);
    }
    if (said.length === 0) return;
    setText(`${said.join('. ')}.`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), CLEAR_MS);
  }, [key]);

  useEffect(() => () => clearTimeout(timer.current), []);
  return text;
}
