import { z } from 'zod';

export const BillItemCategory = z.enum(['food', 'drink', 'other']);
export type BillItemCategory = z.infer<typeof BillItemCategory>;

// Which part of the meal a food item is. A best guess from the parser, used
// only to group items for display; nothing about money depends on it.
// Optional so bills parsed before it existed stay valid.
export const BillItemCourse = z.enum(['starter', 'main', 'side', 'dessert']);
export type BillItemCourse = z.infer<typeof BillItemCourse>;

export const BillItemSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string().min(1),
  unitPricePence: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  category: BillItemCategory,
  course: BillItemCourse.optional(),
  // Set by the reader on a line it couldn't read clearly ("price faded").
  // The lead is asked to check those lines before Review bill; any edit of
  // the bill (amend) clears it, since the lead has then seen every line.
  unsure: z.string().max(60).optional(),
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
  // Optional for forward-compat with bills parsed before this field existed.
  // Bills without it can't serve image-url; the endpoint returns IMAGE_UNAVAILABLE.
  uploadId: z.string().uuid().optional(),
  // Whether this bill's read came from the parser or the analysis cache, and
  // when that read was made. Optional: bills from before the cache lack them.
  source: z.enum(['parser', 'cache']).optional(),
  analysedAt: z.string().datetime().optional(),
  // Set on a bill made by Start again (POST /v1/bills/{billId}/fork): the
  // bill and version it started from.
  forkedFrom: z
    .object({ billId: z.string().uuid(), versionNumber: z.number().int().min(1) })
    .optional(),
});
export type ParsedFrom = z.infer<typeof ParsedFromSchema>;

/**
 * A discount the reader couldn't tie to one item (8 Nov 2026): shown under
 * the items and shared by what each person had, like service, but taken off.
 * A discount on one item is folded into that item's price instead.
 */
export const BillDiscountSchema = z.object({
  name: z.string().min(1).max(200),
  amountPence: z.number().int().positive(),
});
export type BillDiscount = z.infer<typeof BillDiscountSchema>;

/** The bill's shared discounts in all (0 for bills from before them). */
export const discountPence = (b: { discounts?: ReadonlyArray<{ amountPence: number }> }): number =>
  (b.discounts ?? []).reduce((acc, d) => acc + d.amountPence, 0);

const BillBaseSchema = z.object({
  billId: z.string().uuid(),
  versionNumber: z.number().int().min(1),
  creatorUserId: z.string(),
  currency: z.literal('GBP'),
  subtotalPence: z.number().int().nonnegative(),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
  discounts: z.array(BillDiscountSchema).max(20).default([]),
  totalPence: z.number().int().nonnegative(),
  // The total printed on the receipt itself, as read by the OCR parser.
  // Kept alongside the computed totalPence so the client can flag a
  // mismatch (typical causes: OCR misread an item price, restaurant
  // arithmetic error, undisclosed discount/tip). Optional because old
  // bills predate this field and not every parser surfaces it.
  parsedTotalPence: z.number().int().nonnegative().optional(),
  items: z.array(BillItemSchema).min(1),
  parsedFrom: ParsedFromSchema,
  venue: VenueSchema.optional(),
  previousVersionId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});

export const BillSchema = BillBaseSchema.refine(
  (b) => {
    const itemsSum = b.items.reduce((acc, i) => acc + i.unitPricePence * i.quantity, 0);
    const off = discountPence(b);
    return (
      b.subtotalPence === itemsSum &&
      off <= itemsSum &&
      b.totalPence === itemsSum + b.taxPence + b.serviceChargePence - off
    );
  },
  {
    message:
      'Bill totals must reconcile: subtotal == sum(items); discounts <= subtotal; total == subtotal + tax + service - discounts',
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
  /** Local only: ignore an earlier read of the same photo. */
  skipCache: z.boolean().optional(),
});
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const ParseRequestSchema = z.object({
  uploadId: z.string().uuid(),
  /** Local only: read the photo again even if it was read before. */
  skipCache: z.boolean().optional(),
});
export type ParseRequest = z.infer<typeof ParseRequestSchema>;

/**
 * Start again: a new bill from the latest version (the lead's corrections
 * carry over) or from what today's parser reads off the photo.
 */
export const ForkBillRequestSchema = z.object({
  from: z.enum(['latest', 'analysis']).default('latest'),
});
export type ForkBillRequest = z.infer<typeof ForkBillRequestSchema>;

// Bounds on what a lead can send (#155): far past any real bill, and they
// keep a bill version well under DynamoDB's 400 KB item limit. Mirrored in
// openapi.yaml.
export const AMEND_LIMITS = {
  items: 200,
  nameLength: 200,
  quantity: 999,
  unitPricePence: 10_000_000, // £100,000
  extraPence: 10_000_000, // tax, service or a discount
  discounts: 20,
} as const;

export const AmendBillRequestSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid().optional(),
        name: z.string().min(1).max(AMEND_LIMITS.nameLength),
        unitPricePence: z.number().int().nonnegative().max(AMEND_LIMITS.unitPricePence),
        quantity: z.number().int().positive().max(AMEND_LIMITS.quantity),
        category: BillItemCategory,
        course: BillItemCourse.optional(),
      }),
    )
    .min(1)
    .max(AMEND_LIMITS.items),
  taxPence: z.number().int().nonnegative().max(AMEND_LIMITS.extraPence),
  serviceChargePence: z.number().int().nonnegative().max(AMEND_LIMITS.extraPence),
  // The shared discount lines. Absent keeps the bill's; [] removes them.
  discounts: z
    .array(
      z.object({
        name: z.string().min(1).max(AMEND_LIMITS.nameLength),
        amountPence: z.number().int().positive().max(AMEND_LIMITS.extraPence),
      }),
    )
    .max(AMEND_LIMITS.discounts)
    .optional(),
  // Set to override the parsed venue. Absent keeps whatever the bill has.
  venue: z
    .object({
      name: z.string().min(1).max(80),
      placeId: z.string().max(200).optional(),
      address: z.string().max(300).optional(),
    })
    .optional(),
});
export type AmendBillRequest = z.infer<typeof AmendBillRequestSchema>;
