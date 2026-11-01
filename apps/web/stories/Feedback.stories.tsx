import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Button, Centre, Dialog, Notice, Spinner } from '@/components/ui';

const meta = { title: 'Feedback/Notice', component: Notice } satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = { args: { title: 'Bill changed', children: 'Callum edited the bill. Check your items.' } };
export const Ok: Story = { args: { tone: 'ok', title: 'You’ve marked £19.41 as paid', children: 'Callum will confirm when it arrives.' } };
export const Failed: Story = { args: { tone: 'error', title: 'Couldn’t start the payment', children: 'Try again.' } };

export const Loading: StoryObj<typeof Spinner> = { render: () => <Spinner /> };

export const Centred: StoryObj<typeof Centre> = {
  render: () => (
    <Centre>
      <Spinner />
      <p className="muted">Reading the bill</p>
    </Centre>
  ),
};

function DialogDemo({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const close = () => { setOpen(false); onClose(); };
  return open ? (
    <Dialog
      title="Close the bill?"
      onClose={close}
      actions={<><Button onClick={close}>Close the bill</Button><Button tone="text" onClick={close}>Not yet</Button></>}
    >
      <p className="muted">Affogato × 2 hasn’t been claimed, so it’s yours.</p>
    </Dialog>
  ) : (
    <Button tone="secondary" onClick={() => setOpen(true)}>Open dialog</Button>
  );
}

export const ADialog: StoryObj<typeof Dialog> = {
  name: 'Dialog',
  parameters: { layout: 'fullscreen' },
  render: () => <div style={{ minHeight: 420, padding: 20 }}><DialogDemo onClose={fn()} /></div>,
};
