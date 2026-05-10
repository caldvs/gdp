import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { s3, BILLS_BUCKET } from '../../storage/s3.js';
import { billStore } from '../../storage/billStore.js';
import { AppError } from '../../errors/AppError.js';
import { uploadKey } from './uploadService.js';
import { BillSchema, type Bill, type BillItem } from '../../types/bills.js';
import type { BillParser, ParsedBillFromImage } from './parser.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const parseService = {
  async parse(input: {
    userId: string;
    uploadId: string;
    requestId: string;
    parser: BillParser;
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
      if (bill) return bill;
      // Index pointed somewhere we can't read — partial write or external
      // mutation. Don't silently re-parse: that would overwrite the index
      // and orphan the original billId. Surface as internal error instead.
      throw new AppError(
        'INTERNAL_ERROR',
        'Image hash index points to a missing bill — manual reconciliation needed',
      );
    }

    const parsed = await input.parser.parse(bytes, input.requestId);
    const bill = BillSchema.parse(
      buildBillV1({
        parsed,
        userId: input.userId,
        uploadId: input.uploadId,
        sha256,
        parser: input.parser,
      }),
    );
    await billStore.putVersion(bill, {
      indexImageHash: { userId: input.userId, sha256 },
    });
    return bill;
  },
};

function buildBillV1(args: {
  parsed: ParsedBillFromImage;
  userId: string;
  uploadId: string;
  sha256: string;
  parser: BillParser;
}): Bill {
  const items: BillItem[] = args.parsed.items.map((it) => ({
    itemId: uuidv7(),
    name: it.name,
    unitPricePence: it.unitPricePence,
    quantity: it.quantity,
    category: it.category,
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
    items,
    parsedFrom: {
      imageHash: args.sha256,
      parser: args.parser.model,
      parserVersion: args.parser.version,
      parsedAt: new Date().toISOString(),
      uploadId: args.uploadId,
    },
    ...(args.parsed.venue ? { venue: args.parsed.venue } : {}),
    createdAt: new Date().toISOString(),
  };
}
