import { describe, it, expect } from 'vitest';
import { mintSessionToken, verifySessionToken } from './sessionToken.js';
import { AppError } from '../../errors/AppError.js';

const secretA = new TextEncoder().encode('a'.repeat(32));
const secretB = new TextEncoder().encode('b'.repeat(32));

describe('sessionToken', () => {
  it('mint + verify roundtrips userId, email, name', async () => {
    const token = await mintSessionToken(
      { userId: 'u-1', email: 'alice@example.com', name: 'Alice' },
      secretA,
    );
    const verified = await verifySessionToken(token, secretA);
    expect(verified.userId).toBe('u-1');
    expect(verified.email).toBe('alice@example.com');
    expect(verified.name).toBe('Alice');
  });

  it('rejects tokens signed with a different secret as AUTH_INVALID', async () => {
    const token = await mintSessionToken({ userId: 'u-1', email: 'a@b' }, secretA);
    await expect(verifySessionToken(token, secretB)).rejects.toBeInstanceOf(AppError);
    await expect(verifySessionToken(token, secretB)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('rejects tampered payloads', async () => {
    const token = await mintSessionToken({ userId: 'u-1', email: 'a@b' }, secretA);
    // Flip the last char of the payload segment.
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${p!.slice(0, -1)}${p!.slice(-1) === 'A' ? 'B' : 'A'}.${s}`;
    await expect(verifySessionToken(tampered, secretA)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('rejects expired tokens with AUTH_EXPIRED', async () => {
    const token = await mintSessionToken(
      { userId: 'u-1', email: 'a@b' },
      secretA,
      -1, // expired 1s ago
    );
    await expect(verifySessionToken(token, secretA)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
  });

  it('rejects tokens with the wrong audience as AUTH_INVALID', async () => {
    // Forge a token with the wrong audience by re-signing via jose
    // directly — verifies the audience check is wired correctly.
    const { SignJWT } = await import('jose');
    const wrongAud = await new SignJWT({ email: 'a@b' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer('gdp-backend')
      .setAudience('someone-else')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secretA);
    await expect(verifySessionToken(wrongAud, secretA)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('omits name in result when claim is absent', async () => {
    const token = await mintSessionToken({ userId: 'u-1', email: 'a@b' }, secretA);
    const verified = await verifySessionToken(token, secretA);
    expect(verified.name).toBeUndefined();
  });
});
