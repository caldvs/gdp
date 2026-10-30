import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Header } from '@/components/AppShell';
import { JoinQr } from '@/components/JoinQr';

const meta = { title: 'Shell/Header', component: Header, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof Header>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithMenu: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return <Header onMenu={() => setOpen((o) => !o)} menuOpen={open} />;
  },
};
export const NoMenu: Story = {};

export const QrCode: StoryObj<typeof JoinQr> = {
  name: 'Join QR',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="qr-box">
      <JoinQr url="https://example.com/join/K7Q2MX" size={208} />
      <span className="muted small">Code</span>
      <span className="code">K7Q2MX</span>
    </div>
  ),
};

export const QrLoading: StoryObj<typeof JoinQr> = {
  name: 'Join QR (no link yet)',
  parameters: { layout: 'padded' },
  render: () => <div className="qr-box"><JoinQr url={null} size={208} /></div>,
};
