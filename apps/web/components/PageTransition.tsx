'use client';

import { ViewTransition, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import '@/app/transitions.css';

/**
 * Page changes: the old page fades out and the new one fades in while
 * rising 8px. Keyed by path, so every navigation is an exit and an enter.
 * The header sits outside it and the action bar has its own name, so both
 * stay still. Styles: app/transitions.css.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
      <div className="vt-page">{children}</div>
    </ViewTransition>
  );
}

/**
 * Text that glides to the same-named text on the next page (a bill's name
 * in the list becomes the bill's heading). Unpaired, it fades with its page.
 */
export function Morph({ name, children }: { name?: string; children: ReactNode }) {
  if (!name) return <>{children}</>;
  return (
    <ViewTransition name={name} share="morph" enter="page-in" exit="page-out" default="none">
      <span className="vt-text">{children}</span>
    </ViewTransition>
  );
}

/** The shared name for a bill's title, in lists and on the bill itself. */
export const billTitle = (sessionId: string) => `bill-title-${sessionId.replace(/[^\w-]/g, '_')}`;
