'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { configureApi, registerQueryClient } from '@gdp/core/api';
import { retryUnlessClientError } from '@gdp/core/api/retry';
import { API_BASE_URL } from '@/lib/config';
import { DemoBanner } from '@/components/DemoBanner';

configureApi({ baseUrl: API_BASE_URL });

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: retryUnlessClientError, staleTime: 30_000, refetchOnWindowFocus: true },
      },
    });
    registerQueryClient(qc);
    return qc;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <DemoBanner />
      {children}
    </QueryClientProvider>
  );
}
