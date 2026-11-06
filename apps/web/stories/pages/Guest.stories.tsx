import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { screen as dom, expect, fireEvent, waitFor, within } from 'storybook/test';
import { FakeCore } from '../../e2e/fakeCore';
import JoinLanding from '@/app/(app)/join/[code]/page';
import Session from '@/app/(app)/session/[id]/page';
import Pay from '@/app/(app)/session/[id]/pay/page';
import { screen } from '../screens/harness';
import { CODE, SID, busyTable, items, midMeal, splittingTable, users } from '../screens/tables';

/** A guest diner's pages, as on the redesign board (Sky · G1–G4). */
const meta = { title: 'Pages/Guest diner' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const JoinLandingPage: Story = {
  name: 'G1 Join: landing page (opened from the QR)',
  parameters: screen({ api: busyTable, path: `/join/${CODE}` }),
  render: () => <JoinLanding />,
};

export const PaymentsWait: Story = {
  name: 'G2 Your items so far: until the lead opens payments (#216)',
  parameters: screen({ user: users.tom, api: () => { const a = new FakeCore({ paymentsOpen: false }); a.join(users.tom); a.participants[1]!.claimedItemIds = [items[1]!.itemId]; return a; }, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const PickArriving: Story = {
  name: 'G2.1 Pick your items: arriving',
  parameters: screen({ user: users.tom, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const AfterClaiming: Story = {
  name: 'G2.2 After claiming',
  parameters: screen({ user: users.tom, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    fireEvent.click(await c.findByRole('button', { name: /^Claim Calamari/ }));
    await new Promise((r) => setTimeout(r, 600));
    fireEvent.click(await c.findByRole('button', { name: /^Claim Espresso Martini 2 of 3/ }));
  },
};

export const SplitConfirm: Story = {
  name: 'G2.1 Split: the row opens in place',
  parameters: screen({ user: users.tom, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    fireEvent.click(await within(canvasElement).findByRole('button', { name: /^Split Olives with/ }));
    await within(canvasElement).findByRole('group', { name: 'Split Olives' });
  },
};

export const Splitting: Story = {
  name: 'G2.4 Splitting the calamari with Priya',
  parameters: screen({ user: users.tom, api: splittingTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const PayTheLead: Story = {
  name: 'G3 Pay the lead',
  parameters: screen({ user: users.tom, api: () => { const a = busyTable(); a.participants[3]!.claimedItemIds = [items[1]!.itemId]; return a; }, path: `/session/${SID}/pay`, payout: { monzo: 'callum.davies', revolut: 'callumd' } }),
  render: () => <Pay />,
};

export const AreYouSure: Story = {
  name: 'G3 Are you sure you’ve paid?',
  parameters: screen({ user: users.tom, api: () => { const a = busyTable(); a.participants[3]!.claimedItemIds = [items[1]!.itemId]; return a; }, path: `/session/${SID}/pay`, payout: { monzo: 'callum.davies' } }),
  render: () => <Pay />,
  play: async ({ canvasElement }) => {
    const paid = await within(canvasElement).findByRole('button', { name: 'I’ve paid' });
    // Enabled once the payment has started.
    await waitFor(() => expect(paid).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(paid);
    await dom.findByRole('dialog');
  },
};

export const PayWithRoundUp: Story = {
  name: 'F6 Pay the lead, rounded up for the £1 hold',
  parameters: screen({ user: users.tom, api: () => { const a = new FakeCore({ platformFeePence: 100, serviceRate: 0.125 }); a.join(users.tom); a.participants[1]!.claimedItemIds = [items[2]!.itemId]; return a; }, path: `/session/${SID}/pay`, payout: {} }),
  render: () => <Pay />,
};

export const Waiting: Story = {
  name: 'G4 Paid: waiting for Callum',
  parameters: screen({ user: users.sam, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const AllSquare: Story = {
  name: 'G4 Paid: Callum confirmed',
  parameters: screen({ user: users.priya, api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const Received: Story = {
  name: 'G4 Paid: Callum marked it received',
  parameters: screen({ user: users.priya, api: midMeal, path: `/session/${SID}` }),
  render: () => <Session />,
};

export const GuestMenu: Story = {
  name: 'G· Menu open (guest)',
  parameters: screen({ user: users.tom, guestName: 'Tom', api: busyTable, path: `/session/${SID}` }),
  render: () => <Session />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('heading', { name: 'What did you have?' });
    fireEvent.click(within(canvasElement).getByRole('button', { name: 'Open menu' }));
  },
};
