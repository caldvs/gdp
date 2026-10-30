'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronLeft, Menu } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@gdp/core/api';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { useIdleSignOut } from '@gdp/core/lib/idle';
import { useScreenTitleOverride } from '@/lib/screen';
import { stashJoinFragment } from '@/lib/joinFragment';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { Avatar } from './Avatar';
import { Button, CenterSpinner, Notice, Spinner } from './ui';

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Group Dine Pay';
  if (pathname === '/capture') return 'New bill';
  if (pathname.startsWith('/confirm-bill/')) return 'Bill';
  if (/^\/session\/[^/]+\/share$/.test(pathname)) return 'Invite diners';
  if (/^\/session\/[^/]+\/pay$/.test(pathname)) return 'Payments';
  if (pathname.startsWith('/session/')) return 'Session';
  if (pathname === '/payout-account') return 'Bank details';
  if (pathname.startsWith('/join/')) return 'Joining…';
  return 'Group Dine Pay';
}

/** Auth gate + top bar + menu for every signed-in screen. */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const [menuOpen, setMenuOpen] = useState(false);
  const goToSignIn = useCallback(() => router.replace('/sign-in'), [router]);
  useIdleSignOut(!!me.data, goToSignIn);

  const status = me.error instanceof ApiError ? me.error.status : 0;
  const unauthenticated = me.isError && (status === 401 || status === 403);

  useEffect(() => {
    if (!unauthenticated) return;
    // A join link's #p= fragment carries the lead's bank details. It must
    // never go to a server, and the redirect below would drop it, so park
    // it in this tab's sessionStorage for the join screen to pick up after
    // sign-in. (The Expo app lost it at this point.)
    if (pathname.startsWith('/join/') && window.location.hash) {
      stashJoinFragment(window.location.hash);
    }
    const search = window.location.search;
    const from = pathname + search;
    router.replace(from && from !== '/' ? `/sign-in?from=${encodeURIComponent(from)}` : '/sign-in');
  }, [unauthenticated, pathname, router]);

  if (me.isPending || unauthenticated) return <CenterSpinner />;
  if (me.isError) {
    return (
      <div className="center">
        <Notice title="Couldn't reach Group Dine Pay." detail={`${me.error.message} (status ${status || 'network'})`} />
        <Button variant="ghost" onClick={() => me.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <>
      <AppHeader pathname={pathname} onMenuOpen={() => setMenuOpen(true)} />
      <main>{children}</main>
      {menuOpen ? <AppMenu onClose={() => setMenuOpen(false)} /> : null}
    </>
  );
}

function AppHeader({ pathname, onMenuOpen }: { pathname: string; onMenuOpen: () => void }) {
  const router = useRouter();
  const override = useScreenTitleOverride();
  const title = override ?? titleFor(pathname);
  const showBack = pathname !== '/';
  useEffect(() => {
    document.title = title === 'Group Dine Pay' ? title : `${title} · Group Dine Pay`;
  }, [title]);
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <div className="topbar__left">
          {showBack ? (
            <button
              type="button"
              className="icon-tap icon-tap--back"
              aria-label="Back"
              onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
            >
              <ChevronLeft size={22} />
            </button>
          ) : null}
          <h1 className="topbar__title">{title}</h1>
        </div>
        <button type="button" className="icon-tap" aria-label="Open menu" onClick={onMenuOpen}>
          <Menu size={20} />
        </button>
      </div>
    </header>
  );
}

function AppMenu({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const router = useRouter();
  const signOut = useSignOut();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (to: string) => {
    onClose();
    router.push(to);
  };

  const handleJoin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const normalised = code.trim().toUpperCase();
    if (normalised.length !== 6) {
      setJoinError('Codes are 6 characters');
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const { sessionId } = await api<{ sessionId: string }>('/v1/sessions/by-code', { method: 'POST', body: { code: normalised } });
      await api(`/v1/sessions/${sessionId}/join`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      setCode('');
      go(`/session/${sessionId}`);
    } catch (err) {
      setJoinError(err instanceof ApiError ? (err.code === 'NOT_FOUND' ? "We couldn't find that code" : err.message) : 'Could not join — try again');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        {me.data ? (
          <div className="menu__user">
            <Avatar uri={me.data.avatarUrl} displayName={me.data.displayName} seed={me.data.userId} size={40} />
            <div style={{ minWidth: 0 }}>
              <div className="menu__name">{me.data.displayName}</div>
              {me.data.email ? <div className="menu__email">{me.data.email}</div> : null}
            </div>
          </div>
        ) : null}
        <button type="button" className="menu__item" onClick={() => go('/capture')}>New bill</button>
        <button type="button" className="menu__item" onClick={() => go('/payout-account')}>Bank details</button>
        <form className="menu__block" onSubmit={handleJoin}>
          <label className="gdp-mini" htmlFor="menu-join">join with code</label>
          <div className="menu__row">
            <input
              id="menu-join"
              className="menu__code"
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); if (joinError) setJoinError(null); }}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              maxLength={6}
              disabled={joining}
            />
            <Button type="submit" disabled={joining || code.trim().length < 6}>{joining ? <Spinner /> : 'Join'}</Button>
          </div>
          {joinError ? <div className="menu__error">{joinError}</div> : null}
        </form>
        <div className="menu__divider" />
        <ThemeToggle />
        <div className="menu__divider" />
        <button
          type="button"
          className="menu__item"
          onClick={async () => {
            onClose();
            await signOut();
            router.replace('/sign-in');
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const options: { value: ThemeMode; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  return (
    <div className="menu__block">
      <span className="gdp-mini">theme</span>
      <div className="segmented" role="group" aria-label="Theme">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={o.value === mode} onClick={() => setMode(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
