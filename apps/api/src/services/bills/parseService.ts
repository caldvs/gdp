import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { s3, BILLS_BUCKET } from '../../storage/s3.js';
import { billStore } from '../../storage/billStore.js';
import { AppError } from '../../errors/AppError.js';
import { baseLogger } from '../../logging/logger.js';
import { uploadKey } from './uploadService.js';
import { BillSchema, type Bill, type BillItem, type Venue } from '../../types/bills.js';
import { readByOf, type BillParser, type ParsedBillFromImage, type ReadBy } from './parser.js';
import type { VenueResolver } from './venueResolver.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const parseService = {
  async parse(input: {
    userId: string;
    uploadId: string;
    requestId: string;
    parser: BillParser;
    venueResolver: VenueResolver;
  }): Promise<Bill> {
    const key = uploadKey(input.userId, input.uploadId);

    let bytes: Uint8Array;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BILLS_BUCKET, Key: key }));
      if (!obj.Body) {
        throw new AppError('NOT_FOUND', 'Upload has no body');
      }
      bytes = await obj.Body.transformToByteArray();
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw new AppError('NOT_FOUND', 'Upload not found or expired');
      }
      if (err instanceof AppError) throw err;
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'NoSuchKey' || errName === 'NotFound') {
        throw new AppError('NOT_FOUND', 'Upload not found or expired');
      }
      throw err;
    }

    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError('INVALID_INPUT', 'Image exceeds 5MB limit');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const existing = await billStore.findByImageHash(input.userId, sha256);
    if (existing) {
      const bill = await billStore.getLatest(existing.billId);
      if (bill) {
        // Legacy bills (parsed before uploadId tracking landed) won't have
        // parsedFrom.uploadId, so /image-url returns 404. We DO have a fresh
        // uploadId from this attempt and the bytes are in S3 — adopt them so
        // the image becomes viewable going forward.
        if (!bill.parsedFrom.uploadId) {
          const adopted: Bill = {
            ...bill,
            parsedFrom: { ...bill.parsedFrom, uploadId: input.uploadId },
          };
          await billStore.putVersion(adopted);
          return adopted;
        }
        return bill;
      }
      // Index pointed somewhere we can't read — partial write or external
      // mutation. Don't silently re-parse: that would overwrite the index
      // and orphan the original billId. Surface as internal error instead.
      throw new AppError(
        'INTERNAL_ERROR',
        'Image hash index points to a missing bill — manual reconciliation needed',
      );
    }

    const parsed = await input.parser.parse(bytes, input.requestId);
    const venue = parsed.venue ? await input.venueResolver.resolve(parsed.venue) : undefined;
    const bill = BillSchema.parse(
      buildBillV1({
        parsed,
        venue,
        userId: input.userId,
        uploadId: input.uploadId,
        sha256,
        readBy: readByOf(input.parser, parsed),
      }),
    );

    // Sanity-check: the printed total on the receipt should match what
    // we computed from items + tax + service. A discrepancy usually
    // means one of:
    //  - OCR misread an item price (computed is wrong, printed is right)
    //  - restaurant arithmetic error (computed is right, printed is wrong)
    //  - undisclosed discount / tip baked into the printed total
    // We don't fail the parse on a mismatch — the client surfaces it as
    // a soft warning so the lead can review before sharing. Logged
    // server-side as a structured event for later analytics.
    if (parsed.totalPence !== undefined && parsed.totalPence !== bill.totalPence) {
      baseLogger.info(
        {
          event: 'bill.total.mismatch',
          billId: bill.billId,
          requestId: input.requestId,
          parsedTotalPence: parsed.totalPence,
          computedTotalPence: bill.totalPence,
          deltaPence: bill.totalPence - parsed.totalPence,
        },
        'parsed/computed total mismatch on bill',
      );
    }

    await billStore.putVersion(bill, {
      indexImageHash: { userId: input.userId, sha256 },
    });
    return bill;
  },
};

function buildBillV1(args: {
  parsed: ParsedBillFromImage;
  venue: Venue | undefined;
  userId: string;
  uploadId: string;
  sha256: string;
  readBy: ReadBy;
}): Bill {
  const items: BillItem[] = args.parsed.items.map((it) => ({
    itemId: uuidv7(),
    name: it.name,
    unitPricePence: it.unitPricePence,
    quantity: it.quantity,
    category: it.category,
    ...(it.category === 'food' && it.course ? { course: it.course } : {}),
  }));
  const subtotalPence = items.reduce((acc, i) => acc + i.unitPricePence * i.quantity, 0);
  const totalPence = subtotalPence + args.parsed.taxPence + args.parsed.serviceChargePence;

  return {
    billId: uuidv7(),
    versionNumber: 1,
    creatorUserId: args.userId,
    currency: 'GBP',
    subtotalPence,
    taxPence: args.parsed.taxPence,
    serviceChargePence: args.parsed.serviceChargePence,
    totalPence,
    // Persist the reader's read-of-the-printed-total alongside the computed
    // total. If they disagree the client surfaces a "check this bill"
    // hint; we don't gate the parse on it.
    ...(args.parsed.totalPence !== undefined ? { parsedTotalPence: args.parsed.totalPence } : {}),
    items,
    parsedFrom: {
      imageHash: args.sha256,
      parser: args.readBy.model,
      parserVersion: args.readBy.version,
      parsedAt: new Date().toISOString(),
      uploadId: args.uploadId,
    },
    ...(args.venue ? { venue: args.venue } : {}),
    createdAt: new Date().toISOString(),
  };
}
