import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { screen as dom, fireEvent, within } from 'storybook/test';
import ReviewBill from '@/app/(app)/confirm-bill/[billId]/page';
import Session from '@/app/(app)/session/[id]/page';
import Share from '@/app/(app)/session/[id]/share/page';
import { screen } from '../screens/harness';
import { BID, SID, busyTable, newTable, users } from '../screens/tables';

/**
 * The platform fee (Sky · F0–F5): a free bill each month, then a £1 hold
 * the guests pay back. Shown with Stripe on; F3, Stripe's own card form,
 * isn't here.
 */
const meta = { title: 'Pages/Platform fee' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SpendACredit: Story = {
  name: 'F0 Review: the button spends a credit',
  parameters: screen({ user: users.lead, api: newTable, path: `/confirm-bill/${BID}`, billing: { fee: 'free', creditsLeft: 1 } }),
  render: () => <ReviewBill />,
};

export const CreditSpent: Story = {
  name: 'F1 Credit spent, QR ready',
  parameters: screen({ user: users.lead, api: newTable, path: `/session/${SID}/share?new=free`, billing: { fee: 'free', creditsLeft: 0 } }),
  render: () => <Share />,
};

export const NoCreditsLeft: Story = {
  name: 'F2 No credits left: a £1 hold',
  parameters: screen({ user: users.lead, api: newTable, path: `/confirm-bill/${BID}`, billing: { fee: 'unpaid', creditsLeft: 0 } }),
  render: () => <ReviewBill />,
};

export const HeldAndShared: Story = {
  name: 'F4 Held: share with the table',
  parameters: screen({ user: users.lead, api: newTable, path: `/session/${SID}/share?new=fee`, billing: { fee: 'held', creditsLeft: 0 } }),
  render: () => <Share />,
};

export const CloseFeePaid: Story = {
  name: 'F5 Close: fee already paid',
  parameters: screen({ user: users.lead, api: busyTable, path: `/session/${SID}`, billing: { fee: 'paid', creditsLeft: 0 } }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    fireEvent.click(await within(canvasElement).findByRole('button', { name: 'Close bill' }));
    await dom.findByRole('dialog');
  },
};
