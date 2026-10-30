const formatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatGBP(pence: number): string {
  if (!Number.isInteger(pence)) {
    throw new Error(`formatGBP requires integer pence, got ${pence}`);
  }
  return formatter.format(pence / 100);
}
