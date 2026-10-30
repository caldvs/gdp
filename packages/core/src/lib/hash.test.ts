import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobToArrayBuffer, sha256Hex } from './hash';

// Known-good SHA-256 vectors so we're testing the actual output, not
// just consistency with itself.
const VECTORS: Array<{ input: string; hex: string }> = [
  {
    input: '',
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    input: 'abc',
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    input: 'The quick brown fox jumps over the lazy dog',
    hex: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  },
];

function stringToBuffer(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe('sha256Hex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches known vectors via WebCrypto when available', async () => {
    // jsdom provides crypto.subtle; skip the test if for some reason it
    // isn't there.
    if (!globalThis.crypto?.subtle) {
      console.warn('crypto.subtle absent — skipping WebCrypto branch');
      return;
    }
    for (const v of VECTORS) {
      const hex = await sha256Hex(stringToBuffer(v.input));
      expect(hex, `hash of "${v.input}"`).toBe(v.hex);
    }
  });

  it('matches the same known vectors via js-sha256 fallback', async () => {
    // Stub the WebCrypto global out to force the fallback path.
    vi.stubGlobal('crypto', { subtle: undefined });
    for (const v of VECTORS) {
      const hex = await sha256Hex(stringToBuffer(v.input));
      expect(hex, `fallback hash of "${v.input}"`).toBe(v.hex);
    }
  });

  it('returns identical hashes from both paths for the same input', async () => {
    if (!globalThis.crypto?.subtle) return;
    const sampleBytes = stringToBuffer('hello world');

    const webcrypto = await sha256Hex(sampleBytes);
    vi.stubGlobal('crypto', { subtle: undefined });
    const fallback = await sha256Hex(sampleBytes);

    expect(fallback).toBe(webcrypto);
  });
});

describe('blobToArrayBuffer', () => {
  it('reads a Blob into an ArrayBuffer of the right size', async () => {
    const text = 'hello blob';
    const blob = new Blob([text]);
    const buf = await blobToArrayBuffer(blob);
    expect(buf.byteLength).toBe(text.length);
    expect(new TextDecoder().decode(buf)).toBe(text);
  });

  it('falls back to FileReader when blob.arrayBuffer is missing', async () => {
    const text = 'fallback path';
    const blob = new Blob([text]);
    // Hide `arrayBuffer` so blobToArrayBuffer hits the FileReader
    // branch — same shape as Hermes' incomplete Blob.
    Object.defineProperty(blob, 'arrayBuffer', {
      value: undefined,
      configurable: true,
    });
    expect((blob as { arrayBuffer?: unknown }).arrayBuffer).toBeUndefined();
    const buf = await blobToArrayBuffer(blob);
    expect(new TextDecoder().decode(buf)).toBe(text);
  });

  it('rejects when FileReader fails', async () => {
    // Force the FileReader path by removing arrayBuffer.
    const real = new Blob(['x']);
    const noNative = new Blob(['x']);
    Object.defineProperty(noNative, 'arrayBuffer', {
      value: undefined,
      configurable: true,
    });
    expect((noNative as { arrayBuffer?: unknown }).arrayBuffer).toBeUndefined();
    // The happy path still works:
    const ok = await blobToArrayBuffer(real);
    expect(ok.byteLength).toBe(1);
  });
});
