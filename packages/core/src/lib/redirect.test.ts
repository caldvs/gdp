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
});
