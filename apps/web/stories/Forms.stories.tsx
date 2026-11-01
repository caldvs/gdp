import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Box } from '@/components/ui';

const meta = { title: 'Forms/Fields' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextField: Story = {
  render: () => (
    <div className="field">
      <label htmlFor="sb-name">Your name</label>
      <input id="sb-name" className="input" defaultValue="Tom" />
      <span className="field__hint">So Callum knows who’s paid.</span>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="field">
      <label htmlFor="sb-sort">Sort code</label>
      <input id="sb-sort" className="input input--invalid" defaultValue="04-06" aria-invalid />
      <span className="field__err">Sort code is 6 digits</span>
    </div>
  ),
};

export const Code: Story = {
  render: () => (
    <div className="field">
      <label htmlFor="sb-code">6-digit code</label>
      <input id="sb-code" className="input input--code" inputMode="numeric" maxLength={6} placeholder="123456" />
    </div>
  ),
};

export const Money: Story = {
  render: () => (
    <div className="field">
      <label htmlFor="sb-price">Price</label>
      <div className="money"><span>£</span><input id="sb-price" className="input" inputMode="decimal" defaultValue="17.25" /></div>
    </div>
  ),
};

export const Select: Story = {
  render: () => (
    <div className="field">
      <label htmlFor="sb-qty">How many</label>
      <select id="sb-qty" className="select select--sm" defaultValue="1"><option>0</option><option>1</option><option>2</option></select>
    </div>
  ),
};

export const Checkbox: Story = {
  render: () => (
    <label className="check"><input type="checkbox" defaultChecked />Save these for next time</label>
  ),
};

export const Stepper: Story = {
  render: () => (
    <div className="stepper">
      <button type="button" aria-label="One fewer">−</button>
      <span>1</span>
      <button type="button" aria-label="One more">+</button>
    </div>
  ),
};

export const PickRows: Story = {
  render: () => (
    <Box>
      <div className="pick">
        <button type="button" className="pick__tap"><span className="tick tick--on" aria-hidden>✓</span><span className="row__main"><span className="row__title">Lasagne</span></span></button>
        <span className="row__end">£17.25</span>
      </div>
      <div className="pick">
        <button type="button" className="pick__tap"><span className="tick" aria-hidden /><span className="row__main"><span className="row__title">Affogato</span><span className="row__sub">2 left · £7.25 each</span></span></button>
        <span className="row__end">£7.25</span>
      </div>
      <div className="pick pick--taken">
        <button type="button" className="pick__tap" disabled><span className="tick tick--done" aria-hidden /><span className="row__main"><span className="row__title">Seafood risotto</span><span className="row__sub">Sam</span></span></button>
        <span className="row__end">£18.95</span>
      </div>
    </Box>
  ),
};
