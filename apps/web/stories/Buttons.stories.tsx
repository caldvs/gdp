import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { ActionBar, Button, CopyIcon, ShareIcon } from '@/components/ui';

const meta = {
  title: 'Buttons/Button',
  component: Button,
  args: { children: 'Continue', onClick: fn() },
  argTypes: { tone: { control: 'inline-radio', options: ['primary', 'secondary', 'danger', 'text'] } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { tone: 'secondary', children: 'Join a bill' } };
export const Danger: Story = { args: { tone: 'danger', children: 'Delete account' } };
export const Text: Story = { args: { tone: 'text', children: 'Create an account to keep a record' } };
export const Small: Story = { args: { tone: 'secondary', small: true, children: 'Edit' } };
export const Busy: Story = { args: { busy: true } };
export const Disabled: Story = { args: { disabled: true } };
export const AsLink: Story = { args: { href: '/', children: 'Scan a bill' } };
export const WithIcons: Story = {
  render: () => (
    <div className="btn-row">
      <Button tone="secondary"><CopyIcon />Copy link</Button>
      <Button tone="secondary"><ShareIcon />Share</Button>
    </div>
  ),
};

export const Bar: StoryObj<typeof ActionBar> = {
  name: 'ActionBar',
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div style={{ minHeight: 240 }}>
      <ActionBar>
        <Button tone="secondary">Join a bill</Button>
        <Button grow>Scan a bill</Button>
      </ActionBar>
    </div>
  ),
};

export const BarStacked: StoryObj<typeof ActionBar> = {
  name: 'ActionBar (stacked)',
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div style={{ minHeight: 240 }}>
      <ActionBar stack>
        <div className="actionbar__total"><span className="muted">Your total incl. service</span><b>£19.41</b></div>
        <Button>Continue to payment</Button>
      </ActionBar>
    </div>
  ),
};
