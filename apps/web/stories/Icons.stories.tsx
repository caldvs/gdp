import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import * as ui from '@/components/ui';

const icons = {
  ChevronLeft: ui.ChevronLeft,
  ChevronRight: ui.ChevronRight,
  MenuIcon: ui.MenuIcon,
  CloseIcon: ui.CloseIcon,
  PlusIcon: ui.PlusIcon,
  TickIcon: ui.TickIcon,
  CopyIcon: ui.CopyIcon,
  PhotoIcon: ui.PhotoIcon,
  MailIcon: ui.MailIcon,
  ShareIcon: ui.ShareIcon,
  QrIcon: ui.QrIcon,
};

const meta = { title: 'Icons/All' } satisfies Meta;
export default meta;

export const All: StoryObj<typeof meta> = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
      {Object.entries(icons).map(([name, Icon]) => (
        <div key={name} className="box" style={{ padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <Icon />
          <span className="small muted">{name}</span>
        </div>
      ))}
    </div>
  ),
};
