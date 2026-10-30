'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Lets a page set the top-bar title (e.g. the venue name once the bill
// has loaded) — the web equivalent of <Stack.Screen options={{ title }} />.
type ScreenContextValue = { title: string | null; setTitle: (t: string | null) => void };
const ScreenContext = createContext<ScreenContextValue>({ title: null, setTitle: () => {} });

export function ScreenProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return <ScreenContext.Provider value={{ title, setTitle }}>{children}</ScreenContext.Provider>;
}

export function useScreenTitleOverride(): string | null {
  return useContext(ScreenContext).title;
}

/** Set the top-bar title while this component is mounted. */
export function useScreenTitle(title: string | null | undefined): void {
  const { setTitle } = useContext(ScreenContext);
  useEffect(() => {
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [title, setTitle]);
}
