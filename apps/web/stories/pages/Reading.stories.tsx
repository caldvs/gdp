import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Button } from '@/components/ui';
import { ReadingWait } from '@/components/Reading';
import { screen } from '../screens/harness';
import { users } from '../screens/tables';
// A URL, not an import: CI typechecks before Next writes its image types.
const photo = new URL('../../e2e/fixtures/bill.jpg', import.meta.url).href;

/**
 * R2 (Sky · R2): what /reading/[id] shows while the bill is read, up to
 * about 15s. The page polls a background read, so this renders its waiting
 * screen with the photo, at the start and 10 seconds in.
 */
const meta = { title: 'Pages/Reading the bill' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const wait = (secondsIn: number) => (
  <ReadingWait photo={photo} title="Reading your bill" slow={secondsIn > 12} since={Date.now() - secondsIn * 1000} actions={<Button tone="secondary" href="/">Back to bills</Button>} />
);

export const JustStarted: Story = {
  name: 'R2 Reading: just started',
  parameters: screen({ user: users.lead, path: '/reading/r-1' }),
  render: () => wait(0),
};

export const TenSecondsIn: Story = {
  name: 'R2 Reading: 10 seconds in',
  parameters: screen({ user: users.lead, path: '/reading/r-1' }),
  render: () => wait(10),
};
