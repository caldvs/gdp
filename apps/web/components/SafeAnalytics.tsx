'use client';

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';

/** Never report a URL fragment: join links carry bank details in `#p=` (#147, ADR-0002). */
export function withoutFragment(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: event.url.split('#')[0] };
}

export function SafeAnalytics() {
  return <Analytics beforeSend={withoutFragment} />;
}
