import { BackLink, Page, Title } from '@/components/ui';

/** Joining is by scanning the lead's QR only (#182): nothing to type here. */
export default function JoinPage() {
  return (
    <Page sub>
      <BackLink href="/">Bills</BackLink>
      <Title title="Join a bill" sub="Scan the QR code on the lead’s phone with your camera." />
      <div className="join-scan" aria-hidden="true">
        <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><rect x="8" y="8" width="8" height="8" rx="1" /></svg>
      </div>
      <p className="small muted">There’s no code to type. Ask whoever paid to show you their QR.</p>
    </Page>
  );
}
