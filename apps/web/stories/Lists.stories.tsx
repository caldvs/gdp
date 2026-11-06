import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { useState } from 'react';
import { Badge, Box, Button as Btn, PlusIcon, Pulse, Row, RowButton, RowLink, Stats, TotalEdit, TotalLine, Totals } from '@/components/ui';

const meta = { title: 'Lists/Row', component: Row } satisfies Meta<typeof Row>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = { args: { title: 'Lasagne', end: '£17.25' }, decorators: [(S) => <Box><S /></Box>] };
export const WithSub: Story = { args: { title: 'Negroni', sub: '1 of 2 left · £10.50 each', end: '£10.50' }, decorators: [(S) => <Box><S /></Box>] };
export const Strong: Story = { args: { title: 'Gennaro', sub: 'Today · 4 people', strong: true, tall: true }, decorators: [(S) => <Box><S /></Box>] };
export const Muted: Story = { args: { title: 'Seafood risotto', sub: 'Sam', end: '£18.95', muted: true }, decorators: [(S) => <Box><S /></Box>] };
export const Card: Story = { args: { title: 'Gennaro', sub: 'Today · 4 people', strong: true, card: true, end: <Badge tone="warn">£23.57 to collect</Badge>, chevron: true } };

export const ABox: Story = {
  args: { title: '' },
  render: () => (
    <Box>
      <RowLink href="/" title="Dishoom" sub="17 Oct · you paid Sam" end="£28.40" tall />
      <RowLink href="/" title="Bundobust" sub="12 Oct · you hosted" end="£142.50" tall />
      <RowLink href="/" title="Rudy’s" sub="4 Oct · you paid Priya" end="£15.50" tall />
    </Box>
  ),
};

export const Link: StoryObj<typeof RowLink> = {
  render: () => <Box><RowLink href="/" title="Bank account" sub="04-06-68 · ••••9660" tall /></Box>,
};

export const Button: StoryObj<typeof RowButton> = {
  args: { title: 'Sign out', onClick: fn() },
  render: (a) => <Box><RowButton {...a} /></Box>,
};

export const AddRow: StoryObj<typeof RowButton> = {
  render: () => (
    <Box>
      <Row title="Olives" end="£4.25" />
      <button type="button" className="row row--add"><PlusIcon />Add item</button>
    </Box>
  ),
};

export const Badges: StoryObj<typeof Badge> = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Badge tone="ok">Paid</Badge>
      <Badge tone="warn">£23.57 to collect</Badge>
      <Badge>Not paid</Badge>
    </div>
  ),
};

export const Total: StoryObj<typeof Totals> = {
  render: () => (
    <Totals>
      <TotalLine k="Subtotal" v="£98.45" tone="mute" />
      <TotalLine k="Service 12.5%" v="£12.31" tone="mute" />
      <TotalLine k="Total" v="£110.76" tone="total" />
    </Totals>
  ),
};

export const StatsRow: StoryObj<typeof Stats> = {
  args: { items: [{ k: 'Bill', v: '£110.76' }, { k: 'Collected', v: '£38.19' }, { k: 'To collect', v: '£23.57', warn: true }] },
  render: (a) => <Stats {...a} />,
};

export const TotalBeingEdited: StoryObj<typeof TotalEdit> = {
  render: () => (
    <Totals>
      <TotalLine k="Subtotal" v="£98.45" tone="mute" />
      <TotalEdit label="Service">
        <input className="input" defaultValue="12.31" inputMode="decimal" aria-label="Service" />
      </TotalEdit>
      <TotalLine k="Total" v="£110.76" tone="total" />
    </Totals>
  ),
};

function PulseDemo() {
  const [n, setN] = useState(2);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Pulse value={n}><strong>{n} joined</strong></Pulse>
      <Btn tone="secondary" small onClick={() => setN(n + 1)}>Someone joins</Btn>
    </div>
  );
}

export const PulseOnChange: StoryObj<typeof Pulse> = { render: () => <PulseDemo /> };
