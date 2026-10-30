import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { BackLink, Box, Button, Page, Row, Section, Title } from '@/components/ui';

const meta = { title: 'Layout/Page', component: Page, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TopLevel: Story = {
  args: {
    children: (
      <>
        <Title title="Bills" />
        <Section title="Open">
          <Box><Row title="Gennaro" sub="Today · 4 people" strong /></Box>
        </Section>
      </>
    ),
  },
};

export const SubPage: Story = {
  args: {
    sub: true,
    children: (
      <>
        <BackLink href="/">Bills</BackLink>
        <Title title="Review bill" sub="Gennaro" />
        <Box><Row title="Olives" end="£4.25" /></Box>
      </>
    ),
  },
};

export const TitleOnly: StoryObj<typeof Title> = {
  render: () => <Title title="Pay Callum £19.41" sub="Gennaro · Callum’s bill" />,
};

export const TitleWithAside: StoryObj<typeof Title> = {
  render: () => <Title title="Gennaro" sub="Today · code K7Q2MX" aside={<Button tone="secondary" small>QR code</Button>} />,
};

export const SectionWithHeading: StoryObj<typeof Section> = {
  render: () => (
    <Section title="Still to claim">
      <Box><Row title="Affogato × 2" end="£14.50" /></Box>
    </Section>
  ),
};

export const Back: StoryObj<typeof BackLink> = {
  render: () => <BackLink href="/">Your items</BackLink>,
};
