import { z } from 'zod';

export const BillItemCategory = z.enum(['food', 'drink', 'other']);
export type BillItemCategory = z.infer<typeof BillItemCategory>;

export const BillItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string().min(1),
  unitPricePence: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  category: BillItemCategory,
});
export type BillItem = z.infer<typeof BillItemSchema>;

export const VenueSchema = z.object({
  placeId: z.string().optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
export type Venue = z.infer<typeof VenueSchema>;

export const ParsedFromSchema = z.object({
  imageHash: z.string().regex(/^[a-f0-9]{64}$/),
  parser: z.string(),
  parserVersion: z.string(),
  parsedAt: z.string().datetime(),
});
export type ParsedFrom = z.infer<typeof ParsedFromSchema>;

const BillBaseSchema = z.object({
  billId: z.string().uuid(),
  versionNumber: z.number().int().min(1),
  creatorUserId: z.string(),
  currency: z.literal('GBP'),
  subtotalPence: z.number().int().nonnegative(),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
  totalPence: z.number().int().nonnegative(),
  items: z.array(BillItemSchema).min(1),
  parsedFrom: ParsedFromSchema,
  venue: VenueSchema.optional(),
  previousVersionId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});

export const BillSchema = BillBaseSchema.refine(
  (b) => {
    const itemsSum = b.items.reduce((acc, i) => acc + i.unitPricePence * i.quantity, 0);
    return (
      b.subtotalPence === itemsSum && b.totalPence === itemsSum + b.taxPence + b.serviceChargePence
    );
  },
  {
    message:
      'Bill totals must reconcile: subtotal == sum(items); total == subtotal + tax + service',
  },
);
export type Bill = z.infer<typeof BillSchema>;

// ---- Request bodies ----

export const UploadRequestSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex chars'),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const ParseRequestSchema = z.object({
  uploadId: z.string().uuid(),
});
export type ParseRequest = z.infer<typeof ParseRequestSchema>;

export const AmendBillRequestSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid().optional(),
        name: z.string().min(1),
        unitPricePence: z.number().int().nonnegative(),
        quantity: z.number().int().positive(),
        category: BillItemCategory,
      }),
    )
    .min(1),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
});
export type AmendBillRequest = z.infer<typeof AmendBillRequestSchema>;
