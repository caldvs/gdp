import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { baseLogger } from '../../logging/logger.js';
import { readStore, type BillRead } from '../../storage/readStore.js';
import { parseService } from './parseService.js';
import { BACKGROUND_READ_BUDGET_MS, type BillParser } from './parser.js';
import type { VenueResolver } from './venueResolver.js';

/** What the background job needs to read one bill. */
export type ReadJob = {
  readId: string;
  userId: string;
  uploadId: string;
  requestId: string;
  /** Read again even if this photo was read before (local testing). */
  skipCache?: boolean;
};

/** Starts a read without waiting for it. */
export type ReadDispatcher = (job: ReadJob) => Promise<void>;

/**
 * A read still `reading` after this long has died (the Lambda was killed or
 * the invoke was lost): report it as a timeout rather than spin forever.
 */
export const STALE_READ_MS = 90_000;

/** Runs one read to the end and records how it went. Never throws. */
export const createReadRunner =
  (deps: { parser: BillParser; venueResolver: VenueResolver }) =>
  async (job: ReadJob): Promise<void> => {
    const started = Date.now();
    // One line per read with how long it took: the read-duration metric and
    // alarm in infra/main.ts are built from it (#172).
    const finished = (status: 'done' | 'failed', code?: string) =>
      baseLogger.info(
        { event: 'bill.read.finished', readId: job.readId, status, code, ms: Date.now() - started },
        'Bill read finished',
      );
    try {
      const bill = await parseService.parse({
        userId: job.userId,
        uploadId: job.uploadId,
        requestId: job.requestId,
        parser: deps.parser,
        venueResolver: deps.venueResolver,
        budgetMs: BACKGROUND_READ_BUDGET_MS,
        skipCache: job.skipCache,
      });
      await readStore.finish(job.readId, { status: 'done', billId: bill.billId });
      finished('done');
    } catch (err) {
      const error =
        err instanceof AppError
          ? {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
            }
          : {
              code: 'INTERNAL_ERROR',
              message: 'Reading the bill failed',
              // #94: the error's name (never its message or stack), so the
              // app can say which kind of thing broke (e.g. a missing AWS
              // credential locally) instead of blaming the photo.
              details: { errorName: (err as { name?: string } | null)?.name ?? 'Error' },
            };
      finished('failed', error.code);
      if (!(err instanceof AppError)) {
        baseLogger.error(
          { event: 'bill.read.crashed', readId: job.readId, err },
          'Bill read crashed',
        );
      }
      await readStore
        .finish(job.readId, { status: 'failed', error })
        .catch((e: unknown) =>
          baseLogger.error(
            { event: 'bill.read.unrecorded', readId: job.readId, err: e },
            'Could not record a failed read',
          ),
        );
    }
  };

/** Runs the read in this process, unawaited. For local dev and tests; a Lambda would freeze it. */
export const inProcessDispatcher =
  (run: (job: ReadJob) => Promise<void>): ReadDispatcher =>
  (job) => {
    void run(job);
    return Promise.resolve();
  };

/** Invokes this same Lambda asynchronously with `{ gdpBillRead: job }`. */
export const lambdaSelfDispatcher = (functionName: string, region: string): ReadDispatcher => {
  const client = new LambdaClient({ region });
  return async (job) => {
    await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ gdpBillRead: job })),
      }),
    );
  };
};

export const isBillReadEvent = (event: unknown): event is { gdpBillRead: ReadJob } => {
  const job = (event as { gdpBillRead?: Partial<ReadJob> } | null)?.gdpBillRead;
  return (
    typeof job?.readId === 'string' &&
    typeof job.userId === 'string' &&
    typeof job.uploadId === 'string' &&
    typeof job.requestId === 'string'
  );
};

export const createReadService = (deps: { dispatch: ReadDispatcher; now?: () => number }) => {
  const now = deps.now ?? Date.now;
  return {
    async start(input: {
      userId: string;
      uploadId: string;
      requestId: string;
      skipCache?: boolean;
    }): Promise<BillRead> {
      const read: BillRead = {
        readId: uuidv7(),
        userId: input.userId,
        uploadId: input.uploadId,
        status: 'reading',
        createdAt: new Date(now()).toISOString(),
      };
      await readStore.create(read);
      try {
        await deps.dispatch({ ...input, readId: read.readId });
      } catch (err) {
        baseLogger.error(
          { event: 'bill.read.dispatch_failed', readId: read.readId, err },
          'Could not start a bill read',
        );
        const error = { code: 'INTERNAL_ERROR', message: 'Could not start reading the bill' };
        await readStore.finish(read.readId, { status: 'failed', error });
        return { ...read, status: 'failed', error };
      }
      return read;
    },

    async get(readId: string, userId: string): Promise<BillRead> {
      const read = await readStore.get(readId);
      // Someone else's read looks the same as a missing one.
      if (!read || read.userId !== userId) throw new AppError('NOT_FOUND', 'Read not found');
      if (read.status === 'reading' && now() - Date.parse(read.createdAt) > STALE_READ_MS) {
        return {
          ...read,
          status: 'failed',
          error: { code: 'PARSE_TIMEOUT', message: 'Reading the bill took too long' },
        };
      }
      return read;
    },
  };
};

export type ReadService = ReturnType<typeof createReadService>;
