import { describe, it, expect } from 'vitest';
import { safeInternalPath } from './redirect';

describe('safeInternalPath', () => {
  it('returns / for empty/missing input', () => {
    expect(safeInternalPath(undefined)).toBe('/');
    expect(safeInternalPath('')).toBe('/');
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath(123)).toBe('/');
  });

  it('passes through internal paths', () => {
    expect(safeInternalPath('/join/ABC123')).toBe('/join/ABC123');
    expect(safeInternalPath('/session/abc/share')).toBe('/session/abc/share');
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeInternalPath('//evil.com')).toBe('/');
    expect(safeInternalPath('//evil.com/join/ABC')).toBe('/');
  });

  it('rejects external URLs', () => {
    expect(safeInternalPath('https://evil.com')).toBe('/');
    expect(safeInternalPath('javascript:alert(1)')).toBe('/');
    expect(safeInternalPath('join/ABC')).toBe('/');
  });

  it('rejects backslash tricks that browsers read as another host (#148)', () => {
    expect(safeInternalPath('/\\evil.com')).toBe('/');
    expect(safeInternalPath('/\\/evil.com')).toBe('/');
    expect(safeInternalPath('\\\\evil.com')).toBe('/');
    expect(safeInternalPath('/join/\\evil')).toBe('/');
  });

  it('rejects control characters browsers strip from URLs', () => {
    expect(safeInternalPath('/\t/evil.com')).toBe('/');
    expect(safeInternalPath('/\n/evil.com')).toBe('/');
    expect(safeInternalPath('/\r/evil.com')).toBe('/');
    expect(safeInternalPath('/\u0000/evil.com')).toBe('/');
    expect(safeInternalPath('/\u007f')).toBe('/');
  });

  it('rejects the same tricks percent-encoded', () => {
    expect(safeInternalPath('/%5Cevil.com')).toBe('/');
    expect(safeInternalPath('/%5cevil.com')).toBe('/');
    expect(safeInternalPath('/%09/evil.com')).toBe('/');
    expect(safeInternalPath('/%2Fevil.com')).toBe('/');
    expect(safeInternalPath('/%E0%A4%A')).toBe('/');
  });

  it('keeps queries and fragments on internal paths', () => {
    expect(safeInternalPath('/join/ABC123?x=1')).toBe('/join/ABC123?x=1');
    expect(safeInternalPath('/join/ABC123#p=abc')).toBe('/join/ABC123#p=abc');
    expect(safeInternalPath('/session/abc%20def')).toBe('/session/abc%20def');
  });
});
