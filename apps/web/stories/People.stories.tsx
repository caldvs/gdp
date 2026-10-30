import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Avatar, Diners } from '@/components/ui';

const meta = {
  title: 'People/Diners',
  component: Diners,
  args: {
    hostId: 'u1',
    meId: 'u3',
    people: [
      { userId: 'u1', displayName: 'Callum Davies' },
      { userId: 'u2', displayName: 'Priya Shah' },
      { userId: 'u3', displayName: 'Tom Reed' },
      { userId: 'u4', displayName: 'Sam' },
    ],
  },
} satisfies Meta<typeof Diners>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AtTheTable: Story = {};
export const JustTheHost: Story = { args: { people: [{ userId: 'u1', displayName: 'Callum Davies' }], meId: 'u1' } };

export const Avatars: StoryObj<typeof Avatar> = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <Avatar name="Callum Davies" />
      <Avatar name="Priya" />
      <Avatar name="Tom Reed" you />
    </div>
  ),
};
