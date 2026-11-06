import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { screen as dom, fireEvent, within } from 'storybook/test';
import Bills from '@/app/(app)/page';
import ReviewBill from '@/app/(app)/confirm-bill/[billId]/page';
import Session from '@/app/(app)/session/[id]/page';
import Share from '@/app/(app)/session/[id]/share/page';
import Summary from '@/app/(app)/session/[id]/summary/page';
import Fee from '@/app/(app)/session/[id]/fee/page';
import { screen } from '../screens/harness';
import { BID, SID, busyTable, closedTable, feeTable, midMeal, newTable, users, withBills } from '../screens/tables';
import { FakeCore } from '../../e2e/fakeCore';

/** The lead diner's pages, as on the redesign board (Sky · L1–L6). */
const meta = { title: 'Pages/Lead diner' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const YourBills: Story = {
  name: 'L1 Your bills',
  parameters: screen({ user: users.lead, api: () => withBills(), path: '/' }),
  render: () => <Bills />,
};

export const ReviewTheBill: Story = {
  name: 'L2 Review the bill',
  parameters: screen({ user: users.lead, api: newTable, path: `/confirm-bill/${BID}`, billing: { fee: 'waived' } }),
  render: () => <ReviewBill />,
};

export const ShareWithTheTable: Story = {
  name: 'L3 Share with the table',
  parameters: screen({ user: users.lead, api: newTable, path: `/session/${SID}/share` }),
  render: () => <Share />,
};

export const YourItems: Story = {
  name: 'L4.1 The bill: Your items tab',
  parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    fireEvent.click(await within(canvasElement).findByRole('tab', { name: 'Your items' }));
  },
};

export const TheTable: Story = {
  name: 'L4.2 The bill: The table tab',
  parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const CloseBeforeClaimed: Story = {
  name: 'L5 Close before everything’s claimed',
  parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    fireEvent.click(await within(canvasElement).findByRole('button', { name: 'Close bill' }));
    await dom.findByRole('dialog');
  },
};

export const MarkReceived: Story = {
  name: 'L4.2 The table: received and says they’ve paid',
  parameters: screen({ user: users.lead, api: midMeal, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const NotSharedYet: Story = {
  name: 'L4 The bill: not shared yet',
  parameters: screen({ user: users.lead, api: () => new FakeCore({ serviceRate: 0.125, status: 'setup' }), path: `/session/${SID}` }),
  render: () => <Session />,
};

export const Closed: Story = {
  name: 'L7 Closed',
  parameters: screen({ user: users.lead, api: closedTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const MenuOpen: Story = {
  name: 'L· Menu open (signed in)',
  parameters: screen({ user: users.lead, api: () => withBills(), path: '/' }),
  render: () => <Bills />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { name: 'Bills' });
    fireEvent.click(within(canvasElement).getByRole('button', { name: 'Open menu' }));
  },
};

export const BillSummary: Story = {
  name: 'L6 Bill summary (statement)',
  parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}/summary` }),
  render: () => <Summary />,
};

export const PlatformFee: Story = {
  name: 'L8 Platform fee',
  parameters: screen({ user: users.lead, api: feeTable, path: `/session/${SID}/fee` }),
  render: () => <Fee />,
};
