import { z } from 'zod';
import { BillItemCategory, BillItemCourse } from '../../types/bills.js';

export const ParsedBillFromImageSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        unitPricePence: z.number().int().nonnegative(),
        quantity: z.number().int().positive(),
        category: BillItemCategory,
        // Gemini may send null or an unexpected label; treat those as unknown
        // rather than failing the whole parse over a display hint.
        course: z
          .unknown()
          .transform((v) => {
            const r = BillItemCourse.safeParse(v);
            return r.success ? r.data : undefined;
          })
          .optional(),
      }),
    )
    .min(1),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
  totalPence: z.number().int().nonnegative().optional(),
  currency: z.literal('GBP'),
  // Gemini sometimes returns `null` for an unknown venue rather than omitting
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

export interface BillParser {
  readonly model: string;
  readonly version: string;
  parse(image: Uint8Array, requestId: string): Promise<ParseResult>;
}

/** The model and version to record on a bill for this parse. */
export const readByOf = (parser: BillParser, result: ParseResult): ReadBy =>
  result.readBy ?? { model: parser.model, version: parser.version };
