import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { BillItemCategory, BillItemCourse } from '../../types/bills.js';

/**
 * The model sometimes puts a food item's course in `category` ("main",
 * "starter"). That item is food: move the label to `course` rather than fail
 * the whole read. Also accepts a category in the wrong case.
 */
function courseAsCategory(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  const item = v as { category?: unknown; course?: unknown };
  if (typeof item.category !== 'string') return v;
  const label = item.category.trim().toLowerCase();
  if (BillItemCategory.safeParse(label).success) return { ...item, category: label };
  if (BillItemCourse.safeParse(label).success) {
    return { ...item, category: 'food', course: item.course ?? label };
  }
  return v;
}

export const ParsedBillFromImageSchema = z.object({
  items: z
    .array(
      z.preprocess(
        courseAsCategory,
        z.object({
          name: z.string().min(1),
          unitPricePence: z.number().int().nonnegative(),
          quantity: z.number().int().positive(),
          category: BillItemCategory,
          // The model may send null or an unexpected label; treat those as unknown
          // rather than failing the whole parse over a display hint.
          course: z
            .unknown()
            .transform((v) => {
              const r = BillItemCourse.safeParse(v);
              return r.success ? r.data : undefined;
            })
            .optional(),
        }),
      ),
    )
    .min(1),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
  totalPence: z.number().int().nonnegative().optional(),
  currency: z.literal('GBP'),
  // The model sometimes returns `null` for an unknown venue rather than omitting
  // the field. Accept both, but normalize the output type to undefined so
  // downstream code (typed `string | undefined`) doesn't have to know.
  venue: z
    .object({
      name: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
      address: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullable()
    .transform((v) => v ?? undefined)
    .optional(),
});
export type ParsedBillFromImage = z.infer<typeof ParsedBillFromImageSchema>;

/** Which model and prompt version actually read the bill. */
export type ReadBy = { model: string; version: string };

/**
 * A parse result. `readBy` is set when the answer may have come from a
 * different model than the parser's own `model` (a fallback chain); when
 * it's missing, the parser's own model read it.
 */
export type ParseResult = ParsedBillFromImage & { readBy?: ReadBy };

export type ParseOptions = {
  /** Aborted when the read has run out of time. Parsers pass it to their HTTP call. */
  signal?: AbortSignal;
};

export interface BillParser {
  readonly model: string;
  readonly version: string;
  parse(image: Uint8Array, requestId: string, opts?: ParseOptions): Promise<ParseResult>;
}

/**
 * Time limits for reading a bill. API Gateway gives up on the Lambda at
 * 30s and answers with a bare 503, so the whole read must finish well
 * before that: S3, the model calls and the venue lookup all fit in it.
 */
export const PARSE_BUDGET_MS = 22_000;
/**
 * A background read (POST /v1/bills/reads) isn't behind API Gateway, so it
 * gets longer: the Lambda's own timeout (60s) is the limit there.
 */
export const BACKGROUND_READ_BUDGET_MS = 45_000;

/** The error a parser throws when its signal aborted the call. */
export const parseTimeout = (who: string) =>
  new AppError('PARSE_TIMEOUT', `${who} took too long to read the bill`);

/** The model and version to record on a bill for this parse. */
export const readByOf = (parser: BillParser, result: ParseResult): ReadBy =>
  result.readBy ?? { model: parser.model, version: parser.version };
