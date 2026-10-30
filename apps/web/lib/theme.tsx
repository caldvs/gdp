'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'gdp.theme.mode';

/**
 * Runs in <head> before React hydrates so the first paint is already in
 * the right theme (same script gdp-mobile injected via +html.tsx).
 */
export const THEME_PREPAINT_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var m=s==='dark'||s==='light'||s==='system'?s:'light';var r=m==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;document.documentElement.setAttribute('data-theme',r);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

type ThemeContextValue = { mode: ThemeMode; resolved: ResolvedTheme; setMode: (m: ThemeMode) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'system' || v === 'light' || v === 'dark') return v;
  } catch {}
  return 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');
  const [system, setSystem] = useState<ResolvedTheme>('light');

  useEffect(() => {
    setModeState(readStored());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystem(mq.matches ? 'dark' : 'light');
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = mode === 'system' ? system : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
