import { describe, it, expect } from 'vitest';
import { localStubVerifier } from './authStub.js';
import { AppError } from '../errors/AppError.js';

describe('localStubVerifier', () => {
  it('accepts dev:<userId> and returns a verified identity', async () => {
    const id = await localStubVerifier('dev:alice');
    expect(id).toMatchObject({ userId: 'alice', email: 'alice@dev.local', name: 'alice' });
    expect(id.picture).toMatch(/^https:\/\/api\.dicebear\.com\/.*alice/);
  });

  it('rejects tokens without dev: prefix', async () => {
    await expect(localStubVerifier('eyJhbGciOiJSUzI1NiIs')).rejects.toBeInstanceOf(AppError);
    await expect(localStubVerifier('eyJhbGciOiJSUzI1NiIs')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('rejects empty userId after dev:', async () => {
    await expect(localStubVerifier('dev:')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });
});
