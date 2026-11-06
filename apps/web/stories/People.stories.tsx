import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AvatarStack, Diners } from '@/components/ui';

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
export const JustTheLead: Story = { args: { people: [{ userId: 'u1', displayName: 'Callum Davies' }], meId: 'u1' } };

/** Who has an item, written out (no avatars, #212). */
export const Names: StoryObj<typeof AvatarStack> = {
  args: { names: ['Callum Davies', 'Priya Shah', 'Tom Reed', 'Sam', 'Ana', 'Jo'] },
  render: (a) => <AvatarStack {...a} />,
};
