// UUIDv7 — RFC 9562. Used as the value for Idempotency-Key on parseBill and initiatePayment.
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  // Prefer the WebCrypto-backed getRandomValues when it exists. Hermes
  // on Expo Go iOS doesn't expose a `crypto` global at all, so we fall
  // back to Math.random — fine for idempotency keys (uniqueness, not
  // cryptographic strength, is what the server actually needs).
  const subtleCrypto = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }).crypto;
  if (subtleCrypto?.getRandomValues) {
    subtleCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
