import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Header } from '@/components/AppShell';
import { ActionBar, Badge, BackLink, Box, Button, Notice, Page, Row, RowLink, Section, Stats, Title, TotalLine, Totals } from '@/components/ui';

/** Whole screens put together from the pieces, to see the tinted page and white cards in context. */
const meta = { title: 'Screens/Lead', parameters: { layout: 'fullscreen' }, decorators: [(S) => <div className="app"><S /></div>] } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Bills: Story = {
  render: () => (
    <>
      <Header onMenu={() => {}} />
      <Page>
        <Title title="Bills" />
        <Section title="Open">
          <RowLink href="/" card title="Gennaro" sub="Today · 4 people" strong end={<Badge tone="warn">£23.57 to collect</Badge>} />
        </Section>
        <Section title="Past">
          <Box>
            <RowLink href="/" tall title="Dishoom" sub="17 Oct · you paid Sam" end="£28.40" />
            <RowLink href="/" tall title="Bundobust" sub="12 Oct · you hosted" end="£142.50" />
            <RowLink href="/" tall title="Rudy’s" sub="4 Oct · you paid Priya" end="£15.50" />
          </Box>
        </Section>
      </Page>
      <ActionBar>
        <Button tone="secondary" href="/">Join a bill</Button>
        <Button grow href="/">Scan a bill</Button>
      </ActionBar>
    </>
  ),
};

export const TheBill: Story = {
  render: () => (
    <>
      <Header onMenu={() => {}} />
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="Gennaro" sub="Today · code K7Q2MX" aside={<Button tone="secondary" small>QR code</Button>} />
        <Stats items={[{ k: 'Bill', v: '£110.76' }, { k: 'Collected', v: '£38.19' }, { k: 'To collect', v: '£23.57', warn: true }]} />
        <Section title="People">
          <Box>
            <Row title="Priya" end={<><Badge tone="ok">Paid</Badge>&nbsp; £38.19</>} />
            <Row title="Sam" sub="Says he’s paid" end="£36.00" tall />
            <Row title="Tom" end={<><Badge>Not paid</Badge>&nbsp; £23.57</>} />
          </Box>
        </Section>
        <Section title="Not claimed yet">
          <Box><Row title="Affogato × 2" end="£14.50" /></Box>
        </Section>
      </Page>
      <ActionBar>
        <Button tone="secondary">Edit bill</Button>
        <Button grow>Close bill</Button>
      </ActionBar>
    </>
  ),
};

export const GuestPaid: Story = {
  name: 'Guest: paid',
  render: () => (
    <>
      <Header onMenu={() => {}} />
      <Page>
        <Notice tone="ok" title="You’ve marked £19.41 as paid">Callum will confirm when it arrives.</Notice>
        <Section title="You had">
          <Box>
            <Row title="Lasagne" end="£17.25" />
            <Row title="Service" end="£2.16" muted />
          </Box>
        </Section>
        <Totals><TotalLine k="Total" v="£19.41" tone="total" /></Totals>
      </Page>
      <ActionBar stack>
        <Button tone="secondary">I had something else</Button>
      </ActionBar>
    </>
  ),
};
