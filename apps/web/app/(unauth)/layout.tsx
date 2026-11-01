'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { Header } from '@/components/AppShell';
import { TestBar } from '@/components/TestBar';
import { Centre, Spinner } from '@/components/ui';

function UnauthGate({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const from = useSearchParams().get('from');
  useEffect(() => {
    if (me.isSuccess) router.replace(safeInternalPath(from));
  }, [me.isSuccess, from, router]);
  if (me.isPending || me.isSuccess) return <Centre><Spinner /></Centre>;
  return <>{children}</>;
}

export default function UnauthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <TestBar open reload={false} />
      <Header />
      <Suspense fallback={<Centre><Spinner /></Centre>}>
        <UnauthGate>{children}</UnauthGate>
      </Suspense>
    </div>
  );
}
