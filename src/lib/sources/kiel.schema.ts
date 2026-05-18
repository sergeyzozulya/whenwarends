import { z } from 'zod';

// Boundary schema for the Kiel collector. The upstream is a binary .xlsx
// workbook (see kiel.ts), so Zod cannot parse the raw response; instead the
// collector extracts a minimal row shape from the target sheet and validates
// THAT here before mapping to snapshots.

export const KielExtractedRowSchema = z.object({
  /** First instant of the data month, ISO-8601 UTC. */
  monthIso: z.string().min(1),
  /** Total aid committed that month, in EUR (already converted from € bn). */
  eur: z.number().finite().nonnegative(),
});

export const KielExtractedRowsSchema = z
  .array(KielExtractedRowSchema)
  .min(1, 'Kiel sheet yielded no commitment rows');

export type KielExtractedRow = z.infer<typeof KielExtractedRowSchema>;
