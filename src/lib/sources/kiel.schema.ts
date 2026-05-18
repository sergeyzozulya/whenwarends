import { z } from 'zod';

// Zod schema for the Kiel Ukraine Support Tracker dataset.
//
// Source (CC BY 4.0, no auth): the Kiel Institute publishes the Ukraine
// Support Tracker as a downloadable workbook plus machine-readable extracts.
// The stable, app-friendly shape we ingest is the "aid commitments over time"
// extract, served as JSON (an array of monthly records). When the institute
// only offers an Excel/CSV file, the project's data pipeline converts it to
// the same JSON-array shape below before this collector runs; the collector
// itself only ever deals with this documented JSON contract.
//
//   Canonical landing page:
//     https://www.ifw-kiel.de/topics/war-against-ukraine/ukraine-support-tracker/
//   JSON extract (CSV-as-JSON, one object per month):
//     https://data.ifw-kiel.de/ukraine-support-tracker/commitments-by-month.json
//
// Each record is a cumulative-or-monthly aid commitment total for a given
// month, denominated in a source currency (the tracker reports headline
// figures in either EUR or USD depending on the export). We capture the
// currency explicitly and convert to EUR in the collector using a daily
// ECB/Frankfurter rate. We parse defensively: unknown extra fields are
// ignored; only the fields the collector consumes are required.

/** Kiel exports may serialise amounts as numbers or numeric strings. */
const numericLike = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  if (!Number.isFinite(n)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `not a finite number: ${String(v)}`,
    });
    return z.NEVER;
  }
  return n;
});

/** Source currency of a Kiel record. The tracker headline is EUR or USD. */
export const KielCurrencySchema = z.enum(['EUR', 'USD']);
export type KielCurrency = z.infer<typeof KielCurrencySchema>;

/**
 * One monthly aid-commitment record. `month` is a calendar month; we anchor
 * the snapshot timestamp at the first instant of that month in UTC. `amount`
 * is the total aid committed expressed in `currency` (billions or absolute —
 * the tracker publishes absolute figures; we pass the figure through and only
 * change the currency, never the magnitude).
 */
export const KielCommitmentRecordSchema = z.object({
  // ISO month. Accept "2024-03" or a full ISO date; normalised in collector.
  month: z.string().min(4),
  amount: numericLike,
  currency: KielCurrencySchema,
});

export type KielCommitmentRecord = z.infer<typeof KielCommitmentRecordSchema>;

/** Top-level extract is an array of monthly records. */
export const KielCommitmentsResponseSchema = z.array(KielCommitmentRecordSchema);

export type KielCommitmentsResponse = z.infer<
  typeof KielCommitmentsResponseSchema
>;

// --- FX rate response (Frankfurter / ECB) ---
//
// Frankfurter (https://api.frankfurter.app) wraps the ECB reference rates and
// is free + key-less. We request EUR-based rates for a given date:
//   GET https://api.frankfurter.app/{date}?from=EUR&to=USD
// Response: { "amount": 1, "base": "EUR", "date": "2024-03-01",
//             "rates": { "USD": 1.0873 } }
// Meaning: 1 EUR = rates.USD USD, so EUR = USD / rates.USD.

export const FrankfurterResponseSchema = z.object({
  amount: z.number(),
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

export type FrankfurterResponse = z.infer<typeof FrankfurterResponseSchema>;

// keep the coercion helper exported for unit testing of edge cases.
export { numericLike };
