// World Bank collector — Russian macro indicators (GDP growth, inflation).
//
// Real endpoint (public, no auth, no key required):
//   GET https://api.worldbank.org/v2/country/RUS/indicator/<CODE>?format=json&per_page=100
//
//   e.g.
//   https://api.worldbank.org/v2/country/RUS/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=100
//   https://api.worldbank.org/v2/country/RUS/indicator/FP.CPI.TOTL.ZG?format=json&per_page=100
//
//   The response is a 2-element array [meta, datapoints[]] (see
//   worldbank.schema.ts). Annual series come back newest-year-first; we take
//   the latest year that actually has a numeric observation (older years and
//   recent placeholder years can be `null`).
//
// Indicators collected:
//   NY.GDP.MKTP.KD.ZG  GDP growth (annual %)            -> metric ru_gdp_growth
//   FP.CPI.TOTL.ZG     Inflation, consumer prices (annual %) -> metric ru_inflation
//
// Output:
//   - one SnapshotInput per indicator. `ts` is the ISO-8601 UTC instant for the
//     start of the observation's calendar year (e.g. year "2023" ->
//     "2023-01-01T00:00:00.000Z"); `value` is the numeric annual figure.
//     World Bank percentages are kept as-is (e.g. -1.2 means -1.2%); these are
//     macro indicators, not 0–1 probabilities.
//
// The HTTP layer is injectable (defaults to the real retrying fetchJson) so
// unit tests run fully offline with mocked payloads.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import { WorldBankResponseSchema } from './worldbank.schema';

export const WORLDBANK_SOURCE = 'worldbank';

/** World Bank indicator code -> the metric name we emit. */
export interface IndicatorSpec {
  code: string;
  metric: string;
}

export const WORLDBANK_INDICATORS: readonly IndicatorSpec[] = [
  { code: 'NY.GDP.MKTP.KD.ZG', metric: 'ru_gdp_growth' },
  { code: 'FP.CPI.TOTL.ZG', metric: 'ru_inflation' },
] as const;

const COUNTRY = 'RUS';

export function indicatorUrl(code: string): string {
  return `https://api.worldbank.org/v2/country/${COUNTRY}/indicator/${code}?format=json&per_page=100`;
}

/** Injectable HTTP layer so tests can supply mock payloads per URL. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/**
 * ISO-8601 UTC instant for the start of a World Bank calendar year string
 * (e.g. "2023" -> "2023-01-01T00:00:00.000Z"). Returns undefined for a
 * non-4-digit-year string so garbage dates are skipped rather than thrown.
 */
export function yearToIsoUtc(date: string): string | undefined {
  if (!/^\d{4}$/.test(date)) return undefined;
  const year = Number(date);
  // Date.UTC avoids any local-timezone offset; always emits a `Z` instant.
  return new Date(Date.UTC(year, 0, 1)).toISOString();
}

/**
 * Parse one raw World Bank response and map it to the FULL annual series —
 * one snapshot per year that has a numeric observation (null placeholder
 * years are skipped, never fabricated). World Bank annual data is free and
 * spans decades, so this yields a real macro history, not one stale year.
 * Exported so tests can exercise the pure mapping without the fetch layer.
 */
export function mapWorldBankResponse(
  raw: unknown,
  metric: string
): SnapshotInput[] {
  const [, data] = WorldBankResponseSchema.parse(raw);
  if (data === null || data.length === 0) return [];

  const out: SnapshotInput[] = [];
  for (const dp of data) {
    if (dp.value === null || !Number.isFinite(dp.value)) continue;
    const ts = yearToIsoUtc(dp.date);
    if (ts === undefined) continue;
    out.push({
      metric,
      source: WORLDBANK_SOURCE,
      ts,
      value: dp.value,
      confidence: 1,
      raw_blob: JSON.stringify({
        indicator: dp.indicator.id,
        year: dp.date,
        label: dp.indicator.value ?? null,
      }),
    });
  }
  return out;
}

/**
 * Build a World Bank collector. The fetcher is injectable purely for testing;
 * production code uses the real retrying fetchJson by default. One indicator
 * failing (bad payload) is isolated so a single bad series doesn't sink the
 * rest of the run.
 */
export function createWorldBankCollector(
  fetcher: JsonFetcher = defaultFetcher,
  indicators: readonly IndicatorSpec[] = WORLDBANK_INDICATORS
): Collector {
  return {
    name: WORLDBANK_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const settled = await Promise.allSettled(
        indicators.map(async ({ code, metric }) => {
          const raw = await fetcher(indicatorUrl(code));
          return mapWorldBankResponse(raw, metric);
        })
      );

      const snapshots: SnapshotInput[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') snapshots.push(...r.value);
      }
      return { snapshots };
    },
  };
}

export const worldbankCollector: Collector = createWorldBankCollector();

// ---------------------------------------------------------------------------
// World Bank Global Economic Monitor (GEM, source=15) — sub-annual macro.
//
// The annual collector above is country=RUS only and yearly. GEM adds the
// higher-frequency series the dashboard needs for BOTH countries:
//
//   • RU consumer-price inflation, MONTHLY, % y/y
//       country=RUS  indicator=CPTOTSAXNZGY  date=YYYYM01:YYYYM12
//   • RU / UA real GDP, QUARTERLY (seas. adj. level, local currency)
//       country=RUS|UKR  indicator=NYGDPMKTPSAKD  date=YYYYQ1:YYYYQ4
//     — published only as a level; we derive the standard % y/y growth as a
//       deterministic 4-quarter ratio of the official levels (not an
//       interpolation, not a fabricated point: every output quarter has a
//       real level AND a real same-quarter-prior-year level behind it).
//
// Real endpoint (public, no auth, no key):
//   GET https://api.worldbank.org/v2/country/<C>/indicator/<CODE>
//       ?source=15&format=json&per_page=400&date=<range>
//
// The response shape is the same [meta, datapoints|null] 2-tuple as the annual
// API (WorldBankResponseSchema already models it); only `date` differs — it is
// "YYYYM##" (month) or "YYYYQ#" (quarter) instead of a bare year.
//
// (UA monthly CPI is NOT in GEM — it comes from the decoded NBU series; see
// src/lib/sources/nbuCpi.ts.)

export const WB_GEM_SOURCE_ID = 15;

export const RU_CPI_YOY_METRIC = 'ru_cpi_yoy';
export const RU_GDP_YOY_METRIC = 'ru_gdp_yoy';
export const UA_GDP_YOY_METRIC = 'ua_gdp_yoy';

export function gemUrl(country: string, code: string, range: string): string {
  return (
    `https://api.worldbank.org/v2/country/${country}/indicator/${code}` +
    `?source=${WB_GEM_SOURCE_ID}&format=json&per_page=400&date=${range}`
  );
}

/**
 * GEM period string → ISO-8601 UTC instant at the start of the period.
 *   "2024M03" -> 2024-03-01T00:00:00.000Z   (month)
 *   "2024Q2"  -> 2024-04-01T00:00:00.000Z   (quarter → its first month)
 * Returns undefined for anything else, so a garbage period is skipped (never
 * fabricated) rather than throwing the whole series away.
 */
export function gemPeriodToIsoUtc(date: string): string | undefined {
  const mm = /^(\d{4})M(\d{2})$/.exec(date);
  if (mm) {
    const y = Number(mm[1]);
    const m = Number(mm[2]);
    if (m < 1 || m > 12) return undefined;
    return new Date(Date.UTC(y, m - 1, 1)).toISOString();
  }
  const qq = /^(\d{4})Q([1-4])$/.exec(date);
  if (qq) {
    const y = Number(qq[1]);
    const q = Number(qq[2]);
    return new Date(Date.UTC(y, (q - 1) * 3, 1)).toISOString();
  }
  return undefined;
}

/**
 * Map a GEM response straight through (value kept as-is — these are already
 * percentages or indices, not 0–1 probabilities). One snapshot per period
 * that has a real numeric observation; null placeholders are skipped.
 */
export function mapGemSeries(raw: unknown, metric: string): SnapshotInput[] {
  const [, data] = WorldBankResponseSchema.parse(raw);
  if (data === null || data.length === 0) return [];
  const out: SnapshotInput[] = [];
  for (const dp of data) {
    if (dp.value === null || !Number.isFinite(dp.value)) continue;
    const ts = gemPeriodToIsoUtc(dp.date);
    if (ts === undefined) continue;
    out.push({
      metric,
      source: WORLDBANK_SOURCE,
      ts,
      value: dp.value,
      confidence: 1,
      raw_blob: JSON.stringify({
        indicator: dp.indicator.id,
        period: dp.date,
        label: dp.indicator.value ?? null,
      }),
    });
  }
  return out;
}

/**
 * Year-over-year % from a quarterly LEVEL series: for each quarter that also
 * has the same quarter one year earlier, value = (level / level₋₄ − 1)·100.
 * The ts is first-of-quarter, so the prior-year quarter is the identical
 * ISO string with the year decremented — an exact match, no tolerance, no
 * gap-bridging. Quarters without a real prior-year base produce NO point.
 */
export function quarterlyYoY(
  levels: { ts: string; v: number }[]
): { ts: string; v: number }[] {
  const byTs = new Map<string, number>();
  for (const p of levels) byTs.set(p.ts, p.v);
  const out: { ts: string; v: number }[] = [];
  for (const { ts, v } of levels) {
    const prevTs = `${Number(ts.slice(0, 4)) - 1}${ts.slice(4)}`;
    const base = byTs.get(prevTs);
    if (base === undefined || base === 0 || !Number.isFinite(base)) continue;
    out.push({ ts, v: (v / base - 1) * 100 });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Map a GEM quarterly real-GDP LEVEL response to a % y/y growth series.
 * Honest by construction: a quarter is emitted only when both it and its
 * same-quarter-prior-year level are real published observations.
 */
export function mapGemGdpYoY(raw: unknown, metric: string): SnapshotInput[] {
  const [, data] = WorldBankResponseSchema.parse(raw);
  if (data === null || data.length === 0) return [];
  const levels: { ts: string; v: number }[] = [];
  for (const dp of data) {
    if (dp.value === null || !Number.isFinite(dp.value)) continue;
    const ts = gemPeriodToIsoUtc(dp.date);
    if (ts === undefined) continue;
    levels.push({ ts, v: dp.value });
  }
  return quarterlyYoY(levels).map(({ ts, v }) => ({
    metric,
    source: WORLDBANK_SOURCE,
    ts,
    value: v,
    confidence: 1,
    raw_blob: JSON.stringify({ indicator: 'NYGDPMKTPSAKD', basis: 'yoy_of_level' }),
  }));
}

interface GemSpec {
  country: string;
  code: string;
  metric: string;
  range: string;
  /** 'asis' = emit the published value; 'gdp_yoy' = derive y/y from levels. */
  kind: 'asis' | 'gdp_yoy';
}

export const WORLDBANK_GEM_SPECS: readonly GemSpec[] = [
  {
    country: 'RUS',
    code: 'CPTOTSAXNZGY',
    metric: RU_CPI_YOY_METRIC,
    range: '2022M01:2026M12',
    kind: 'asis',
  },
  {
    country: 'RUS',
    code: 'NYGDPMKTPSAKD',
    metric: RU_GDP_YOY_METRIC,
    // 2021 quarters are the y/y base for the first war quarter.
    range: '2021Q1:2026Q4',
    kind: 'gdp_yoy',
  },
  {
    country: 'UKR',
    code: 'NYGDPMKTPSAKD',
    metric: UA_GDP_YOY_METRIC,
    range: '2021Q1:2026Q4',
    kind: 'gdp_yoy',
  },
] as const;

/**
 * Build the GEM collector. Separate from the annual collector (different
 * frequency, different countries, different transform) and separately
 * registered, so one failing series is isolated and the legacy annual
 * collector's behaviour/tests are untouched. Source attribution on every
 * snapshot stays `worldbank` (the data IS World Bank); only the collector
 * NAME differs so the runner reports it distinctly.
 */
export function createWorldBankGemCollector(
  fetcher: JsonFetcher = defaultFetcher,
  specs: readonly GemSpec[] = WORLDBANK_GEM_SPECS
): Collector {
  return {
    name: 'worldbank-gem',
    async run(_env: Env): Promise<CollectorResult> {
      const settled = await Promise.allSettled(
        specs.map(async (s) => {
          const raw = await fetcher(gemUrl(s.country, s.code, s.range));
          return s.kind === 'gdp_yoy'
            ? mapGemGdpYoY(raw, s.metric)
            : mapGemSeries(raw, s.metric);
        })
      );
      const snapshots: SnapshotInput[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') snapshots.push(...r.value);
      }
      return { snapshots };
    },
  };
}

export const worldbankGemCollector: Collector = createWorldBankGemCollector();
