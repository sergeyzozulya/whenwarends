import { z } from 'zod';

// Zod schema + defensive CSV parsing for the Kiel Ukraine Support Tracker.
//
// ── Chosen data source ──────────────────────────────────────────────────────
// Canonical origin (CC BY 4.0, no auth, free):
//   Kiel Institute — Ukraine Support Tracker dataset
//   Landing page:
//     https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/
//   Topic page:
//     https://www.kielinstitut.de/topics/war-against-ukraine/ukraine-support-tracker/
//
// REALITY (documented honestly, see file header of kiel.ts): the Kiel Institute
// does NOT publish a clean public JSON/CSV REST API for this tracker. The data
// ships as a versioned Excel workbook whose direct URL embeds a per-release
// UUID and a `Release_NN` counter (e.g. `…-Ukraine_Support_Tracker_Release_28
// .xlsx`). That URL rotates on every release, so hard-coding it guarantees
// breakage. No durable machine endpoint (OWID grapher, HDX dataset, etc.)
// currently re-publishes the time series with a stable slug either.
//
// Therefore the collector treats the *source URL as configuration* (env
// `KIEL_DATASET_URL`, see kiel.ts) pointing at a CSV representation of the
// "aid commitments over time" series, parses it defensively (CSV → row objects
// → Zod), and on an unreachable / unparseable source throws a clear typed
// error so this one widget degrades in isolation. It never fabricates numbers.
//
// Expected CSV shape (header row + data rows), tolerant to extra columns and
// column-order changes; only the consumed columns are required:
//   month,amount,currency
//   2024-03,1000000000,EUR
//   2024-04,500000000,USD
// (`month` may also be a full ISO date; normalised in the collector.)

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
export const KielCurrencySchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(['EUR', 'USD']));
export type KielCurrency = z.infer<typeof KielCurrencySchema>;

/**
 * One monthly aid-commitment record. `month` is a calendar month; we anchor
 * the snapshot timestamp at the first instant of that month in UTC. `amount`
 * is the total aid committed expressed in `currency`. We pass the figure
 * through and only change the currency, never the magnitude.
 */
export const KielCommitmentRecordSchema = z.object({
  // ISO month. Accept "2024-03" or a full ISO date; normalised in collector.
  month: z.string().min(4),
  amount: numericLike,
  currency: KielCurrencySchema,
});

export type KielCommitmentRecord = z.infer<typeof KielCommitmentRecordSchema>;

/** Top-level extract is a non-empty array of monthly records. */
export const KielCommitmentsResponseSchema = z
  .array(KielCommitmentRecordSchema)
  .min(1, 'Kiel extract contained no parseable commitment rows');

export type KielCommitmentsResponse = z.infer<
  typeof KielCommitmentsResponseSchema
>;

// ── Defensive CSV parsing ───────────────────────────────────────────────────
//
// No CSV/XLSX library is a project dependency (only zod), so we ship a small
// dependency-free RFC-4180-ish reader: handles quoted fields, embedded commas,
// escaped double-quotes (""), and CRLF/LF line endings. It is intentionally
// minimal — anything it cannot make sense of bubbles up as a thrown error at
// the collector boundary rather than silently producing partial data.

/** Split a single CSV document into an array of string-cell rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      // Treat CRLF (and a lone CR) as one row terminator.
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Flush trailing field/row unless the document ended exactly on a newline.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop blank lines (a row that is a single empty cell).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/**
 * Convert a header + body CSV grid into row objects keyed by (normalised)
 * header name, then keep only the three columns this collector consumes.
 * Header matching is case-insensitive and tolerant of common Kiel aliases so
 * a minor export header rename does not break ingest. Returns *unvalidated*
 * objects; the caller Zod-parses them at the boundary.
 */
export function csvToCommitmentRows(grid: string[][]): unknown[] {
  if (grid.length < 2) {
    throw new Error('Kiel CSV has no data rows (need header + ≥1 row)');
  }
  const header = grid[0].map((h) => h.trim().toLowerCase());

  const findCol = (aliases: string[]): number => {
    for (let c = 0; c < header.length; c++) {
      if (aliases.includes(header[c])) return c;
    }
    return -1;
  };

  const monthCol = findCol(['month', 'date', 'period', 'month_year']);
  const amountCol = findCol([
    'amount',
    'amount_eur',
    'amount_usd',
    'value',
    'total',
    'committed',
    'commitments',
  ]);
  const currencyCol = findCol(['currency', 'unit', 'denomination', 'ccy']);

  if (monthCol < 0 || amountCol < 0 || currencyCol < 0) {
    throw new Error(
      `Kiel CSV missing required columns (month/amount/currency); ` +
        `saw header: ${grid[0].join(',')}`
    );
  }

  const out: unknown[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    // Skip short/ragged rows rather than throwing — Kiel workbooks often have
    // trailing note rows. A genuinely empty result still fails Zod's .min(1).
    if (
      cells.length <= Math.max(monthCol, amountCol, currencyCol) ||
      cells[monthCol].trim() === ''
    ) {
      continue;
    }
    out.push({
      month: cells[monthCol].trim(),
      amount: cells[amountCol].trim(),
      currency: cells[currencyCol].trim(),
    });
  }
  return out;
}

// ── FX rate response (Frankfurter / ECB) ────────────────────────────────────
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
