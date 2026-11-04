'use client';

import { Suspense } from 'react';
import { SignInScreen } from '@/components/EmailSignIn';

/** Sign in or create an account: where the header's Sign in goes. */
export default function SignInEmailPage() {
  return (
    <Suspense fallback={null}>
      <SignInScreen />
    </Suspense>
  );
}
