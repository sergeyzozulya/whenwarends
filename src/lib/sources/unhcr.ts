// UNHCR collector — the humanitarian dimension: Ukrainians displaced by the
// war, both refugees abroad and internally displaced persons (IDPs). A durable
// de-escalation would eventually show in refugee returns, so displacement is a
// slow but real "is this ending" signal.
//
// Source: UNHCR Refugee Data Finder (public, no auth, CC BY 4.0 — credit).
//   GET https://api.unhcr.org/population/v1/population/
//         ?limit=1000&yearFrom=2022&yearTo=<year>&coo=UKR&coa_all=true
//
// One annual, authoritative source for BOTH series: with country-of-origin
// fixed to Ukraine, summing `refugees` across all countries of asylum gives
// refugees abroad; summing `idps` gives Ukraine's IDP stock (IDPs are
// attributed only to the origin country). Verified 2026-05-22: 2025 ≈ 5.3M
// refugees, 3.8M IDPs — matching the published figures.
//
// (IOM DTM is the other IDP source, but its API is gated and its HDX data is
// fragile per-round XLSX lagging months behind; UNHCR's own annual IDP figure
// is consistent with IOM's and keeps this a single clean source. IOM could be
// added later for higher-cadence IDPs.)
//
// Cadence: annual end-of-year stock, pinned to 31 Dec of the observation year
// (the figure is a year-end count, not a Jan-1 value).

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import { UnhcrPopulationResponseSchema } from './unhcr.schema';

export const UNHCR_SOURCE = 'unhcr';
export const REFUGEES_METRIC = 'refugees_from_ukraine';
export const IDPS_METRIC = 'ua_idps';

const WAR_START_YEAR = 2022;

export function populationUrl(yearTo: number, yearFrom: number = WAR_START_YEAR): string {
  return (
    'https://api.unhcr.org/population/v1/population/' +
    `?limit=1000&yearFrom=${yearFrom}&yearTo=${yearTo}&coo=UKR&coa_all=true`
  );
}

/** Injectable HTTP layer so tests run offline. */
export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/** End-of-year stock instant for a year (31 Dec, midnight Z). */
export function yearEndIsoUtc(year: number): string {
  return new Date(Date.UTC(year, 11, 31)).toISOString();
}

/**
 * Aggregate the per-asylum-country rows into one refugees + one IDP snapshot
 * per year (31 Dec). Refugees and IDPs are summed across countries of asylum;
 * since IDPs are attributed only to the origin country, that sum is Ukraine's
 * IDP stock. Years with a zero total for a metric are skipped (never
 * fabricated). Exported for offline testing.
 */
export function mapPopulation(raw: unknown): SnapshotInput[] {
  const { items } = UnhcrPopulationResponseSchema.parse(raw);
  const byYear = new Map<number, { refugees: number; idps: number }>();
  for (const r of items) {
    const acc = byYear.get(r.year) ?? { refugees: 0, idps: 0 };
    acc.refugees += r.refugees;
    acc.idps += r.idps;
    byYear.set(r.year, acc);
  }
  const out: SnapshotInput[] = [];
  for (const [year, { refugees, idps }] of byYear) {
    const ts = yearEndIsoUtc(year);
    if (refugees > 0) {
      out.push({ metric: REFUGEES_METRIC, source: UNHCR_SOURCE, ts, value: refugees, confidence: 1, raw_blob: JSON.stringify({ year }) });
    }
    if (idps > 0) {
      out.push({ metric: IDPS_METRIC, source: UNHCR_SOURCE, ts, value: idps, confidence: 1, raw_blob: JSON.stringify({ year }) });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function createUnhcrCollector(
  fetcher: JsonFetcher = defaultFetcher,
  now: () => Date = () => new Date()
): Collector {
  return {
    name: UNHCR_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const raw = await fetcher(populationUrl(now().getUTCFullYear()));
      const snapshots = mapPopulation(raw);
      if (snapshots.length === 0) {
        throw new Error('UNHCR returned no parseable displacement rows');
      }
      return { snapshots };
    },
  };
}

export const unhcrCollector: Collector = createUnhcrCollector();
