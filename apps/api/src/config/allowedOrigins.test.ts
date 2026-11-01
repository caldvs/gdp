import { describe, expect, it } from 'vitest';
import { ALLOWED_ORIGINS, originMatcher, parseOrigins } from './allowedOrigins.js';

describe('originMatcher', () => {
  const dev = originMatcher(ALLOWED_ORIGINS.dev);
  const prod = originMatcher(ALLOWED_ORIGINS.prod);

  it('allows the listed origins exactly', () => {
    expect(prod('https://paymeback.dev')).toBe(true);
    expect(dev('https://test.paymeback.dev')).toBe(true);
    expect(dev('http://localhost:8081')).toBe(true);
  });

  it('matches Vercel preview URLs with the wildcard', () => {
    expect(dev('https://web-nqib-du27dnobe-caldvs-projects.vercel.app')).toBe(true);
    expect(dev('https://evil.com/x-caldvs-projects.vercel.app')).toBe(false);
    expect(dev('https://-caldvs-projects.vercel.app')).toBe(false);
  });

  it('refuses look-alikes and anything not listed', () => {
    expect(prod('https://paymeback.dev.evil.com')).toBe(false);
    expect(prod('http://paymeback.dev')).toBe(false);
    expect(prod('https://test.paymeback.dev')).toBe(false);
    expect(prod('http://localhost:8081')).toBe(false);
    expect(prod('https://web-nqib-abc-caldvs-projects.vercel.app')).toBe(false);
  });

  it('prod lists no wildcard and no localhost', () => {
    expect(ALLOWED_ORIGINS.prod.some((o) => o.includes('*') || o.includes('localhost'))).toBe(
      false,
    );
  });

  it('allows anything when the list is empty (local)', () => {
    expect(originMatcher([])('http://anything:1234')).toBe(true);
  });

  it('rejects a pattern with two wildcards', () => {
    expect(() => originMatcher(['https://*.*.dev'])).toThrow();
  });
});

describe('parseOrigins', () => {
  it('splits and trims a comma list', () => {
    expect(parseOrigins(' https://a.dev, https://b.dev ,')).toEqual([
      'https://a.dev',
      'https://b.dev',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
  });
});
