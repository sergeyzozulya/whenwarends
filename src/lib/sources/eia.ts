// U.S. EIA collector — daily Brent crude spot price (war-financing proxy).
//
// Real endpoint (EIA Open Data API v2; FREE api_key required, no other auth):
//   GET https://api.eia.gov/v2/petroleum/pri/spt/data/
//         ?api_key=<KEY>&frequency=daily&data[0]=value
//         &facets[series][]=RBRTE&start=2022-01-01
//         &sort[0][column]=period&sort[0][direction]=asc&length=5000
//
//   RBRTE = "Europe Brent Spot Price FOB (Dollars per Barrel)", daily. Oil is
//   the backbone of Russia's war budget, so the Brent benchmark is a direct,
//   neutral, public signal on the financing side of "when does the war end".
//   (The Urals discount / Russian-banked revenue is the CREA collector's job;
//   this is the global benchmark line.)
//
// One request returns the whole 2022→now daily series (~1100 rows, well under
// EIA's 5000 row cap), so there is no pagination. Each row → one SnapshotInput
// with metric 'oil_brent_usd', source 'eia', value = USD/bbl, ts = midnight Z
// of the trading day. The HTTP layer is injectable so tests run fully offline.
//
// API key: read from Env.EIA_API_KEY (free, https://www.eia.gov/opendata/).
// Absent → throw a clear, isolatable error (the runner degrades this one
// widget, never fabricates a price).

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import { EiaResponseSchema } from './eia.schema';

export const EIA_SOURCE = 'eia';
export const OIL_BRENT_METRIC = 'oil_brent_usd';

/** EIA series id: Europe Brent Spot Price FOB, daily ($/bbl). */
export const BRENT_SERIES = 'RBRTE';
/** War-start lower bound, matching the other collectors / Kiel earliest. */
export const HISTORY_START = '2022-01-01';

export function brentUrl(apiKey: string, start: string = HISTORY_START): string {
  const qs = [
    `api_key=${encodeURIComponent(apiKey)}`,
    'frequency=daily',
    'data[0]=value',
    `facets[series][]=${BRENT_SERIES}`,
    `start=${start}`,
    'sort[0][column]=period',
    'sort[0][direction]=asc',
    'length=5000',
  ].join('&');
  return `https://api.eia.gov/v2/petroleum/pri/spt/data/?${qs}`;
}

/** Injectable HTTP layer so tests supply a mock payload without a network. */
export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/** EIA daily period "YYYY-MM-DD" → midnight-Z ISO instant, or undefined. */
export function periodToIsoUtc(period: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return undefined;
  const d = new Date(`${period}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "78.98" | 78.98 → 78.98; anything non-finite → null (row is skipped). */
function toFiniteNumber(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one raw EIA response and map it to the full daily Brent series — one
 * snapshot per trading day with a real numeric price. Null/garbage values and
 * unparseable periods are skipped, never fabricated. Exported so tests can
 * exercise the pure mapping without the fetch layer.
 */
export function mapEiaResponse(raw: unknown): SnapshotInput[] {
  const { response } = EiaResponseSchema.parse(raw);
  const out: SnapshotInput[] = [];
  for (const row of response.data) {
    const value = toFiniteNumber(row.value);
    if (value === null) continue;
    const ts = periodToIsoUtc(row.period);
    if (ts === undefined) continue;
    out.push({
      metric: OIL_BRENT_METRIC,
      source: EIA_SOURCE,
      ts,
      value,
      confidence: 1,
      raw_blob: JSON.stringify({ series: BRENT_SERIES, period: row.period }),
    });
  }
  return out;
}

/** Read the free EIA key off Env; throw a clear, isolatable error if absent. */
function readApiKey(env: Env): string {
  const key = (env as { EIA_API_KEY?: unknown }).EIA_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(
      'EIA_API_KEY is missing from Env. Add it as a wrangler secret / .dev.vars ' +
        'entry (free key: https://www.eia.gov/opendata/) before enabling the oil collector.'
    );
  }
  return key.trim();
}

export function createEiaCollector(fetcher: JsonFetcher = defaultFetcher): Collector {
  return {
    name: EIA_SOURCE,
    async run(env: Env): Promise<CollectorResult> {
      const apiKey = readApiKey(env);
      const raw = await fetcher(brentUrl(apiKey));
      const snapshots = mapEiaResponse(raw);
      if (snapshots.length === 0) {
        throw new Error('EIA returned no parseable Brent rows');
      }
      return { snapshots };
    },
  };
}

export const eiaCollector: Collector = createEiaCollector();
