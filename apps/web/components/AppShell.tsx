'use client';

import { useCallback, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useIdleSignOut } from '@gdp/core/lib/idle';
import { stashJoinFragment } from '@/lib/joinFragment';
import { Btn, Centre, Notice, Spin } from './glass';

/**
 * Auth gate for signed-in screens. There's no shared top bar any more:
 * each screen floats its own controls over the bill photo.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  // Idle sign-out: come back to where you were after signing in again.
  const goToSignIn = useCallback(() => {
    const from = window.location.pathname + window.location.search;
    router.replace(from && from !== '/' ? `/sign-in?from=${encodeURIComponent(from)}` : '/sign-in');
  }, [router]);
  useIdleSignOut(!!me.data, goToSignIn);

  const status = me.error instanceof ApiError ? me.error.status : 0;
  const unauthenticated = me.isError && (status === 401 || status === 403);

  useEffect(() => {
    if (!unauthenticated) return;
    // A join link's #p= fragment carries the lead's bank details. It must
    // never go to a server, and the redirect below would drop it, so park
    // it in this tab's sessionStorage for the join screen to pick up.
    if (pathname.startsWith('/join/') && window.location.hash) {
      stashJoinFragment(window.location.hash);
    }
    const from = pathname + window.location.search;
    router.replace(from && from !== '/' ? `/sign-in?from=${encodeURIComponent(from)}` : '/sign-in');
  }, [unauthenticated, pathname, router]);

  if (me.isPending || unauthenticated) return <Centre><Spin /></Centre>;
  if (me.isError) {
    return (
      <Centre>
        <Notice error title="Can't reach Group Dine Pay.">{me.error.message}</Notice>
        <Btn tone="ghost" onClick={() => me.refetch()}>Try again</Btn>
      </Centre>
    );
  }
  return <>{children}</>;
}
