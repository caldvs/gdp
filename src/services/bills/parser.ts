import { z } from 'zod';
import { BillItemCategory } from '../../types/bills.js';

export const ParsedBillFromImageSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        unitPricePence: z.number().int().nonnegative(),
        quantity: z.number().int().positive(),
        category: BillItemCategory,
      }),
    )
    .min(1),
  taxPence: z.number().int().nonnegative(),
  serviceChargePence: z.number().int().nonnegative(),
  totalPence: z.number().int().nonnegative().optional(),
  currency: z.literal('GBP'),
  venue: z
    .object({
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
});
export type ParsedBillFromImage = z.infer<typeof ParsedBillFromImageSchema>;

export interface BillParser {
  readonly model: string;
  readonly version: string;
  parse(image: Uint8Array, requestId: string): Promise<ParsedBillFromImage>;
}
