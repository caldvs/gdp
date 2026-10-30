import { describe, expect, it } from 'vitest';
import { cleanHandle, monzoPayUrl, revolutPayUrl } from './quickPay';

describe('quickPay', () => {
  it('cleans pasted handles', () => {
    expect(cleanHandle('@callumd')).toBe('callumd');
    expect(cleanHandle('https://monzo.me/callum.davies/10')).toBe('callum.davies');
    expect(cleanHandle(' revolut.me/callumd ')).toBe('callumd');
    expect(cleanHandle('')).toBe('');
  });

  it('builds a Monzo link with amount and note', () => {
    expect(monzoPayUrl('callum.davies', 2410, 'gdp-1a2b3c4d')).toBe('https://monzo.me/callum.davies/24.10?d=gdp-1a2b3c4d');
    expect(monzoPayUrl('callum.davies', 2410, 'Dinner at Gennaro')).toBe('https://monzo.me/callum.davies/24.10?d=Dinner%20at%20Gennaro');
  });

  it('falls back to the bare profile without an amount', () => {
    expect(monzoPayUrl('callum.davies')).toBe('https://monzo.me/callum.davies');
    expect(monzoPayUrl('callum.davies', 0)).toBe('https://monzo.me/callum.davies');
  });

  it('returns null for an empty handle', () => {
    expect(monzoPayUrl('  ')).toBeNull();
    expect(revolutPayUrl('@')).toBeNull();
  });

  it('builds a Revolut profile link', () => {
    expect(revolutPayUrl('@callumd')).toBe('https://revolut.me/callumd');
  });
});
