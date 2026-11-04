'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { Header } from '@/components/AppShell';
import { TestBar } from '@/components/TestBar';
import { PageTransition } from '@/components/PageTransition';
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

/** The homepage's links; not on a sign-in screen (or a redirect to one). */
function FrontDoorHeader() {
  const from = useSearchParams().get('from');
  const home = usePathname() === '/sign-in';
  return <Header wide signIn={home && !from} />;
}

export default function UnauthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <TestBar open reload={false} />
      <Suspense fallback={<Header wide />}>
        <FrontDoorHeader />
      </Suspense>
      <PageTransition>
        <Suspense fallback={<Centre><Spinner /></Centre>}>
          <UnauthGate>{children}</UnauthGate>
        </Suspense>
      </PageTransition>
    </div>
  );
}
