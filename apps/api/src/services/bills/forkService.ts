import { v7 as uuidv7 } from 'uuid';
import { billStore } from '../../storage/billStore.js';
import { analysisStore } from '../../storage/analysisStore.js';
import { AppError } from '../../errors/AppError.js';
import { BillSchema, type Bill, type ForkBillRequest } from '../../types/bills.js';
import { PARSE_BUDGET_MS, type BillParser } from './parser.js';
import type { VenueResolver } from './venueResolver.js';
import { analyse, buildBillV1, uploadBytes } from './parseService.js';

/**
 * Start again (docs/design/analysis-cache.md, step 3): a new bill for the
 * same photo, so a settled split can be split again. Version 1 is a copy of
 * the latest version (`latest`: the lead's corrections carry over) or what
 * today's parser reads off the photo (`analysis`: the cached read for the
 * current fingerprint, else a new read, which counts against the daily
 * cap). New item ids, `parsedFrom.forkedFrom` names where it came from, and
 * the photo's hash index moves to the new bill, so the next repeat of the
 * photo opens it. The old bill and its sessions are left as they are.
 * Only the bill's owner can fork it.
 */
export const forkService = {
  async fork(input: {
    billId: string;
    userId: string;
    from: ForkBillRequest['from'];
    requestId: string;
    parser: BillParser;
    venueResolver: VenueResolver;
  }): Promise<Bill> {
    const current = await billStore.getLatest(input.billId);
    // Hide other people's bills: the same answer as a missing one.
    if (!current || current.creatorUserId !== input.userId) {
      throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    }
    const forkedFrom = { billId: current.billId, versionNumber: current.versionNumber };
    const fresh =
      input.from === 'analysis' ? await fromAnalysis(input, current) : fromLatest(current);
    const bill = BillSchema.parse({
      ...fresh,
      parsedFrom: { ...fresh.parsedFrom, forkedFrom },
    });
    await billStore.putVersion(bill, {
      indexImageHash: { userId: input.userId, sha256: current.parsedFrom.imageHash },
    });
    return bill;
  },
};

function fromLatest(current: Bill): Bill {
  const now = new Date().toISOString();
  const { previousVersionId: _previous, ...rest } = current;
  return {
    ...rest,
    billId: uuidv7(),
    versionNumber: 1,
    items: current.items.map((it) => ({ ...it, itemId: uuidv7() })),
    createdAt: now,
  };
}

async function fromAnalysis(
  input: { userId: string; requestId: string; parser: BillParser; venueResolver: VenueResolver },
  current: Bill,
): Promise<Bill> {
  const sha256 = current.parsedFrom.imageHash;
  const uploadId = current.parsedFrom.uploadId;
  // A bill from before upload ids has no photo to read again or show behind it.
  if (!uploadId) {
    throw new AppError('NOT_FOUND', 'Original image is not available for this bill');
  }
  const cached = await analysisStore.get(sha256, input.parser.fingerprint);
  const analysis = cached
    ? { ...cached, source: 'cache' as const }
    : await analyse({
        ...input,
        bytes: await uploadBytes(input.userId, uploadId),
        sha256,
        signal: AbortSignal.timeout(PARSE_BUDGET_MS),
      });
  return buildBillV1({
    parsed: analysis.parsed,
    venue: analysis.venue,
    userId: input.userId,
    uploadId,
    sha256,
    readBy: analysis.readBy,
    source: analysis.source,
    analysedAt: analysis.analysedAt,
  });
}
