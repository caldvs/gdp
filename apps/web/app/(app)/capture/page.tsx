'use client';

import { useState } from 'react';
import { useScanner } from '@/components/Scanner';
import { ActionBar, BackLink, Button, Notice, Page, Title } from '@/components/ui';

/** Scan a bill: take a photo or choose one (drop one in on a computer). */
export default function ScanPage() {
  const scanner = useScanner();
  const [over, setOver] = useState(false);
  if (scanner.reading) return <>{scanner.inputs}{scanner.reading}</>;

  return (
    <>
      {scanner.inputs}
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="Scan a bill" sub="Get the whole bill in the photo, flat and in good light." />
        {scanner.error ? <Notice tone="error" title={scanner.error.title}>{scanner.error.body}</Notice> : null}
        <div
          className={over ? 'box dropzone--over' : 'box'}
          style={{ padding: 24, textAlign: 'center' }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void scanner.handleFile(e.dataTransfer.files?.[0]); }}
        >
          <p className="muted small">On a computer you can drop a photo here.</p>
        </div>
      </Page>
      <ActionBar>
        <Button tone="secondary" onClick={scanner.openLibrary}>Choose a photo</Button>
        <Button grow onClick={scanner.openCamera}>Take a photo</Button>
      </ActionBar>
    </>
  );
}
