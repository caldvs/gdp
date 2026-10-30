'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { Centre, Spin } from '@/components/glass';

function UnauthGate({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const from = useSearchParams().get('from');
  useEffect(() => {
    if (me.isSuccess) router.replace(safeInternalPath(from));
  }, [me.isSuccess, from, router]);
  if (me.isPending || me.isSuccess) return <Centre><Spin /></Centre>;
  return <>{children}</>;
}

export default function UnauthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<Centre><Spin /></Centre>}>
      <UnauthGate>{children}</UnauthGate>
    </Suspense>
  );
}
