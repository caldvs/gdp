'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { configureApi, registerQueryClient } from '@gdp/core/api';
import { API_BASE_URL } from '@/lib/config';
import { ThemeProvider } from '@/lib/theme';
import { ScreenProvider } from '@/lib/screen';
import { DemoBanner } from '@/components/DemoBanner';

configureApi({ baseUrl: API_BASE_URL });

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: 2, staleTime: 30_000, refetchOnWindowFocus: true },
      },
    });
    registerQueryClient(qc);
    return qc;
  });

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ScreenProvider>
          <DemoBanner />
          {children}
        </ScreenProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
