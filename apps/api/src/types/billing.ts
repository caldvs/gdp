import { z } from 'zod';

/** The bill a table fee hold is for. */
export const StartTableFeeRequestSchema = z
  .object({ billId: z.string().uuid() })
  .meta({ id: 'StartTableFeeRequest' });
