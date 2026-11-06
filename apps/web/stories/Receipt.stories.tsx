import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Receipt, ReceiptLine } from '@/components/ui';

/** The bill, and only the bill, as a receipt (#212). */
const meta = { title: 'Bill/Receipt', component: Receipt, args: { head: 'Gennaro', end: 'Sat 31 Oct', children: null } } satisfies Meta<typeof Receipt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ABill: Story = {
  render: (a) => (
    <Receipt {...a}>
      <ReceiptLine name="Olives" price="4.25" />
      <ReceiptLine name="Calamari" price="22.50" />
      <ReceiptLine name="Negroni" note="1 of 2" price="10.50" />
      <ReceiptLine name="Service 12.5%" price="13.00" quiet />
      <ReceiptLine name="Total" price="£117.00" strong />
    </Receipt>
  ),
};

function Claiming() {
  const [mine, setMine] = useState<Record<string, boolean>>({ cal: true });
  const line = (id: string, name: string, price: string, note?: string, theirs?: string) => (
    <ReceiptLine
      key={id}
      name={name}
      note={theirs ? `${note ? note + ' · ' : ''}${theirs} has it` : note}
      price={price}
      quiet={!!theirs}
      tools={theirs
        ? <a href="#split" className="link-btn">Split</a>
        : <button type="button" className="claim-btn" aria-pressed={!!mine[id]} onClick={() => setMine((m) => ({ ...m, [id]: !m[id] }))}>{mine[id] ? '✓ Claimed' : 'Claim'}</button>}
    />
  );
  return (
    <Receipt head="Gennaro" end="Callum paid">
      {line('oli', 'Olives', '4.25', undefined, 'Callum')}
      {line('cal', 'Calamari', '22.50')}
      {line('las', 'Lasagne', '17.25', undefined, 'Sam')}
      {line('neg2', 'Negroni', '10.50', '2 of 2 · 1 left')}
    </Receipt>
  );
}

/** Claim on each line; claimed turns blue (tap again to undo). */
export const WithClaims: Story = { render: () => <Claiming /> };
