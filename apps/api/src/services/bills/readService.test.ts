import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import type { BillRead } from '../../storage/readStore.js';

const store = new Map<string, BillRead>();
vi.mock('../../storage/readStore.js', () => ({
  readStore: {
    create: vi.fn((r: BillRead) => {
      store.set(r.readId, r);
      return Promise.resolve();
    }),
    get: vi.fn((id: string) => Promise.resolve(store.get(id) ?? null)),
    finish: vi.fn((id: string, outcome: Partial<BillRead>) => {
      const r = store.get(id);
      if (r && r.status === 'reading') store.set(id, { ...r, ...outcome });
      return Promise.resolve();
    }),
  },
}));

const parse = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('./parseService.js', () => ({ parseService: { parse: (...a: unknown[]) => parse(...a) } }));

const { createReadRunner, createReadService, isBillReadEvent, STALE_READ_MS } =
  await import('./readService.js');
const { BACKGROUND_READ_BUDGET_MS } = await import('./parser.js');

const deps = {
  parser: { model: 'm', version: 'v1', parse: vi.fn() },
  venueResolver: { resolve: vi.fn() },
};
const job = { userId: 'u1', uploadId: 'up1', requestId: 'r1' };

beforeEach(() => {
  store.clear();
  parse.mockReset();
});

describe('read service', () => {
  it('starts a read and hands the job to the dispatcher', async () => {
    const dispatch = vi.fn(() => Promise.resolve());
    const read = await createReadService({ dispatch }).start(job);
    expect(read.status).toBe('reading');
    expect(dispatch).toHaveBeenCalledWith({ ...job, readId: read.readId });
  });

  it('fails the read if it could not be started', async () => {
    const reads = createReadService({ dispatch: () => Promise.reject(new Error('no')) });
    const read = await reads.start(job);
    expect(read).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
    expect(store.get(read.readId)?.status).toBe('failed');
  });

  it("won't show a read to anyone but its owner", async () => {
    const reads = createReadService({ dispatch: () => Promise.resolve() });
    const read = await reads.start(job);
    await expect(reads.get(read.readId, 'someone-else')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(reads.get('missing', 'u1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports a read stuck in reading as a timeout', async () => {
    let t = 1_000_000;
    const reads = createReadService({ dispatch: () => Promise.resolve(), now: () => t });
    const read = await reads.start(job);
    t += STALE_READ_MS - 1;
    expect((await reads.get(read.readId, 'u1')).status).toBe('reading');
    t += 2;
    expect(await reads.get(read.readId, 'u1')).toMatchObject({
      status: 'failed',
      error: { code: 'PARSE_TIMEOUT' },
    });
  });
});

describe('read runner', () => {
  const started = async () => {
    const reads = createReadService({ dispatch: () => Promise.resolve() });
    return reads.start(job);
  };

  it('records the bill when the read works, with the longer background budget', async () => {
    const read = await started();
    parse.mockResolvedValue({ billId: 'b1' });
    await createReadRunner(deps)({ ...job, readId: read.readId });
    expect(store.get(read.readId)).toMatchObject({ status: 'done', billId: 'b1' });
    expect(parse.mock.calls[0]?.[0]).toMatchObject({ budgetMs: BACKGROUND_READ_BUDGET_MS });
  });

  it('records the error when the read fails', async () => {
    const read = await started();
    parse.mockRejectedValue(
      new AppError('PARSE_TIMEOUT', 'Bedrock took too long to read the bill'),
    );
    await createReadRunner(deps)({ ...job, readId: read.readId });
    expect(store.get(read.readId)).toMatchObject({
      status: 'failed',
      error: { code: 'PARSE_TIMEOUT' },
    });
  });

  it("doesn't leak an unexpected error's message, only its name (#94)", async () => {
    const read = await started();
    const err = new Error('socket hang up at 10.0.0.1');
    err.name = 'CredentialsProviderError';
    parse.mockRejectedValue(err);
    await createReadRunner(deps)({ ...job, readId: read.readId });
    expect(store.get(read.readId)?.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Reading the bill failed',
      details: { errorName: 'CredentialsProviderError' },
    });
  });
});

describe('isBillReadEvent', () => {
  it('accepts only a complete job', () => {
    expect(isBillReadEvent({ gdpBillRead: { ...job, readId: 'x' } })).toBe(true);
    expect(isBillReadEvent({ gdpBillRead: { readId: 'x' } })).toBe(false);
    expect(isBillReadEvent({ version: '2.0', rawPath: '/' })).toBe(false);
    expect(isBillReadEvent(null)).toBe(false);
  });
});
