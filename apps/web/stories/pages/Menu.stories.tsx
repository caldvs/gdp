import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import Account from '@/app/(app)/account/page';
import BankDetails from '@/app/(app)/payout-account/page';
import JoinABill from '@/app/(app)/join/page';
import SignIn from '@/app/(unauth)/sign-in/email/page';
import { screen } from '../screens/harness';
import { users, withBills } from '../screens/tables';

/** Pages off the menu (Sky · M1–M5). M3 Help isn't built. */
const meta = { title: 'Pages/Menu screens' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AccountPage: Story = {
  name: 'M1 Account',
  parameters: screen({ user: users.lead, api: () => withBills(), path: '/account', billing: { creditsLeft: 1 } }),
  render: () => <Account />,
};

export const BankDetailsPage: Story = {
  name: 'M2 Bank details',
  parameters: screen({ user: users.lead, path: '/payout-account' }),
  render: () => <BankDetails />,
};

export const SignInPage: Story = {
  name: 'M4 Sign in or create account',
  parameters: screen({ path: '/sign-in/email', shell: 'front' }),
  render: () => <SignIn />,
};

export const JoinADifferentBill: Story = {
  name: 'M5 Join a different bill: scan only',
  parameters: screen({ user: users.lead, path: '/join' }),
  render: () => <JoinABill />,
};
