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
import {
  WorldBankResponseSchema,
  type WorldBankDatapoint,
} from './worldbank.schema';

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
 * Pick the most recent datapoint that has a numeric value. The API returns
 * newest year first, but recent years are often `null` placeholders, so we
 * scan for the first non-null entry.
 */
function latestObservation(
  data: readonly WorldBankDatapoint[]
): WorldBankDatapoint | undefined {
  for (const dp of data) {
    if (dp.value !== null && Number.isFinite(dp.value)) return dp;
  }
  return undefined;
}

/**
 * Parse one raw World Bank response and map it to at most one snapshot.
 * Exported so tests can exercise the pure mapping without the fetch layer.
 */
export function mapWorldBankResponse(
  raw: unknown,
  metric: string
): SnapshotInput | null {
  const [, data] = WorldBankResponseSchema.parse(raw);
  if (data === null || data.length === 0) return null;

  const obs = latestObservation(data);
  if (!obs) return null;

  const ts = yearToIsoUtc(obs.date);
  if (ts === undefined) return null;

  // value is guaranteed non-null & finite by latestObservation().
  const value = obs.value as number;

  return {
    metric,
    source: WORLDBANK_SOURCE,
    ts,
    value,
    confidence: 1,
    raw_blob: JSON.stringify({
      indicator: obs.indicator.id,
      year: obs.date,
      label: obs.indicator.value ?? null,
    }),
  };
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
        if (r.status === 'fulfilled' && r.value !== null) {
          snapshots.push(r.value);
        }
      }
      return { snapshots };
    },
  };
}

export const worldbankCollector: Collector = createWorldBankCollector();
