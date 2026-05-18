import { z } from 'zod';

// NASA FIRMS Area API — Zod schema for the CSV-as-rows response.
//
// Real endpoint (public domain, free MAP_KEY required, no other auth):
//
//   GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/
//         <MAP_KEY>/VIIRS_SNPP_NRT/<bbox>/<days>
//
//   - <MAP_KEY>  free key from https://firms.modaps.eosdis.nasa.gov/api/area/
//   - VIIRS_SNPP_NRT  Near-Real-Time VIIRS S-NPP active-fire product
//   - <bbox>     west,south,east,north  (we use a Ukraine bounding box)
//   - <days>     look-back window in days (1..10 for the area API)
//
// The endpoint returns CSV text, NOT JSON. The first line is the header; each
// subsequent line is one fire/heat detection. We split the CSV into objects in
// the collector and validate each object with this schema. Columns observed
// for the VIIRS area product:
//
//   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
//   instrument,confidence,version,bright_ti5,frp,daynight
//
// We only consume `acq_date` (UTC calendar date of acquisition) for the daily
// aggregation; the rest are kept (optional, permissive) for the raw blob and
// possible future filtering. `confidence` for VIIRS NRT is a category code:
// "l" (low), "n" (nominal), "h" (high) — kept as a string, not coerced.
//
// FIRMS also returns a plain-text error body (e.g. "Invalid MAP_KEY." or a
// quota message) with HTTP 200 instead of CSV. The collector detects the
// missing/garbled header and throws so the runner isolates this source.

/** One FIRMS VIIRS active-fire detection row (post CSV-to-object parse). */
export const FirmsFireRowSchema = z.object({
  // acq_date is the UTC calendar date of the satellite acquisition, "YYYY-MM-DD".
  acq_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'acq_date must be YYYY-MM-DD'),
  acq_time: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  bright_ti4: z.string().optional(),
  scan: z.string().optional(),
  track: z.string().optional(),
  satellite: z.string().optional(),
  instrument: z.string().optional(),
  confidence: z.string().optional(),
  version: z.string().optional(),
  bright_ti5: z.string().optional(),
  frp: z.string().optional(),
  daynight: z.string().optional(),
});

export type FirmsFireRow = z.infer<typeof FirmsFireRowSchema>;

/** The whole response is an array of detection rows. */
export const FirmsFireRowsSchema = z.array(FirmsFireRowSchema);

export type FirmsFireRows = z.infer<typeof FirmsFireRowsSchema>;

/**
 * Parse FIRMS CSV text into header-keyed row objects. Pure string handling so
 * it is unit-testable without a network. Returns [] for empty input. Quoted
 * fields are not used by the FIRMS area product, so a simple comma split is
 * sufficient and intentionally kept minimal. Rows whose column count does not
 * match the header are skipped (defensive against truncated streams); the
 * caller then Zod-validates what survives.
 */
export function parseFirmsCsv(csv: string): Array<Record<string, string>> {
  const text = csv.replace(/^\uFEFF/, '').trim();
  if (text === '') return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 1) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  // A valid FIRMS area CSV must carry the acq_date column; its absence means
  // the body is an error/quota message rather than data.
  if (!header.includes('acq_date')) {
    throw new Error(
      `FIRMS CSV missing 'acq_date' header (got: ${header.join(',') || '<empty>'})`
    );
  }
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length !== header.length) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = cells[c].trim();
    }
    rows.push(row);
  }
  return rows;
}
