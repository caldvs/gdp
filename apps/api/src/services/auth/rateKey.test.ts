import { describe, expect, it } from 'vitest';
import { rateKeyForEmail } from './rateKey.js';
import { emailHash } from '../../logging/emailHash.js';

describe('rateKeyForEmail (#146)', () => {
  it('drops a +tag and the case', () => {
    expect(rateKeyForEmail(' Sam+1@Example.com ')).toBe('sam@example.com');
    expect(rateKeyForEmail('sam+a+b@example.com')).toBe('sam@example.com');
  });

  it('drops Gmail dots and treats googlemail as gmail', () => {
    expect(rateKeyForEmail('Sam.Smith+x@gmail.com')).toBe('samsmith@gmail.com');
    expect(rateKeyForEmail('s.a.m.smith@googlemail.com')).toBe('samsmith@gmail.com');
  });

  it('keeps dots for other domains', () => {
    expect(rateKeyForEmail('sam.smith@example.com')).toBe('sam.smith@example.com');
  });

  it('leaves odd shapes alone', () => {
    expect(rateKeyForEmail('+tag@example.com')).toBe('+tag@example.com');
    expect(rateKeyForEmail('nobody')).toBe('nobody');
  });
});

describe('emailHash (#155)', () => {
  it('is short, stable and ignores case, and is not the address', () => {
    const h = emailHash('Sam@Example.com');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(emailHash(' sam@example.com')).toBe(h);
    expect(h).not.toContain('sam');
  });
});
