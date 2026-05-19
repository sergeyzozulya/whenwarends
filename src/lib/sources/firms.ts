// NASA FIRMS collector — fire/heat anomalies as a combat-zone proxy over
// Ukraine.
//
// Real endpoint (public domain; free MAP_KEY required, no other auth):
//
//   GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/
//         <MAP_KEY>/VIIRS_SNPP_NRT/<bbox>/<days>
//
// The area API returns CSV text (not JSON). We fetch it as text via the shared
// fetchWithRetry, parse the CSV into objects, Zod-validate each row, then
// aggregate the detection count per UTC calendar day over a Ukraine bounding
// box. Each day becomes one SnapshotInput with metric 'fire_anomalies' and a
// daily ISO-8601 UTC timestamp (midnight Z of that acq_date).
//
// MAP_KEY: this collector needs a free FIRMS MAP_KEY. The frozen src/lib/types.ts
// `Env` interface does NOT yet declare it, so we read it defensively from the
// `env` object passed to run() and throw a clear, isolatable error when it is
// absent. The required Env + wrangler change is documented in the PR report,
// NOT made here (types.ts is frozen).

import type { Collector, Env, SnapshotInput } from '../types';
import { fetchWithRetry } from './contract';
import { FirmsFireRowsSchema, parseFirmsCsv } from './firms.schema';

/** Ukraine bounding box: west,south,east,north (lon/lat, WGS84). */
export const UKRAINE_BBOX = '22.0,44.0,40.3,52.4';

/** VIIRS S-NPP Near-Real-Time active-fire product. */
const PRODUCT = 'VIIRS_SNPP_NRT';

/** Area API look-back window in days. FIRMS area CSV accepts only 1..5
 * ("Invalid day range. Expects [1..5]." otherwise) — verified live. */
const LOOKBACK_DAYS = 5;

// CURRENT-ONLY, by deliberate decision (2026-05-19). GDELT/CBR/NBU were
// extended to real war-start history; FIRMS is intentionally NOT. Rationale:
// the NRT product has no archive, and historical VIIRS would require hundreds
// of ≤5-day chunked requests against the 100k-events/month budget — the
// highest quota cost of any source for the weakest signal (a daily fire
// count). So fire stays a recent-window proxy; reconstructed historical
// briefs honestly report it as unavailable rather than burn the quota. This
// is a documented choice, not an oversight (cf. CBR/NBU reserves omissions).

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/** Injectable fetcher so tests can supply CSV text without a network. */
export type CsvFetcher = (url: string) => Promise<string>;

const defaultFetcher: CsvFetcher = async (url) => {
  const res = await fetchWithRetry(url, { init: { headers: { accept: 'text/csv' } } });
  if (!res.ok) throw new Error(`FIRMS HTTP ${res.status} for ${url}`);
  return res.text();
};

/**
 * Read FIRMS_MAP_KEY off the Env without widening the frozen Env type. The key
 * is not declared in src/lib/types.ts (frozen), so we treat env as a string map
 * for this one optional lookup. Throws a clear error if absent so the runner
 * isolates this source instead of silently producing zero snapshots.
 */
function readMapKey(env: Env): string {
  // Env is frozen and does not declare FIRMS_MAP_KEY; index it as a string map.
  const key = (env as unknown as Record<string, unknown>)['FIRMS_MAP_KEY'];
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(
      "FIRMS_MAP_KEY is missing from Env. Add it to the Env interface and " +
        'wrangler.toml/secret (see firms collector report) before enabling this source.'
    );
  }
  return key.trim();
}

export function buildFirmsUrl(mapKey: string): string {
  return `${FIRMS_BASE}/${encodeURIComponent(mapKey)}/${PRODUCT}/${UKRAINE_BBOX}/${LOOKBACK_DAYS}`;
}

/**
 * Aggregate validated FIRMS rows into a daily fire-count, keyed by the UTC
 * acq_date. Returns SnapshotInput[] sorted ascending by timestamp.
 */
export function aggregateDaily(
  rows: ReadonlyArray<{ acq_date: string }>
): SnapshotInput[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.acq_date, (counts.get(r.acq_date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({
      metric: 'fire_anomalies',
      source: 'firms',
      // acq_date is a UTC calendar date; pin to midnight Z for an ISO-8601 ts.
      ts: `${date}T00:00:00Z`,
      value: count,
      confidence: 1,
    }));
}

export interface FirmsCollectorOptions {
  /** Override the CSV fetcher (tests inject mock CSV text). */
  fetcher?: CsvFetcher;
}

export function makeFirmsCollector(opts: FirmsCollectorOptions = {}): Collector {
  const fetcher = opts.fetcher ?? defaultFetcher;
  return {
    name: 'firms',
    async run(env: Env) {
      const mapKey = readMapKey(env);
      const url = buildFirmsUrl(mapKey);
      const csv = await fetcher(url);
      // parseFirmsCsv throws if the body is a FIRMS error/quota message
      // (no acq_date header) so the runner isolates this source.
      const objects = parseFirmsCsv(csv);
      const rows = FirmsFireRowsSchema.parse(objects);
      const snapshots = aggregateDaily(rows);
      return { snapshots };
    },
  };
}

/** Default collector instance using the real network fetcher. */
export const firmsCollector: Collector = makeFirmsCollector();
