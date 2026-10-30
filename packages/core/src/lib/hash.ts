// Cross-platform Blob → ArrayBuffer and SHA-256 hex digest. Kept
// platform-agnostic so the same code path runs on web, Expo Go iOS
// (Hermes), and tests (jsdom or node).

// Web's native Blob exposes `.arrayBuffer()`; Hermes on iOS does not
// (RN issue 33059). Both runtimes have FileReader, which is the
// portable fallback.
export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new Error('FileReader did not return an ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(blob);
  });
}

// Prefer the native WebCrypto path when available — it's much faster
// (offloaded to C++) and what the web build uses. Hermes on Expo Go
// doesn't expose a `crypto` global at all, so we fall back to the
// pure-JS implementation from `js-sha256`. Both produce the same
// hash for identical input bytes, so server-side content-dedup works
// across web and native.
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const { sha256 } = await import('js-sha256');
  return sha256(new Uint8Array(buffer));
}
