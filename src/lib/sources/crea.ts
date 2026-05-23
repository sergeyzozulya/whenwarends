// CREA collector — cumulative € paid to Russia for fossil fuels since the
// full-scale invasion, as a daily series. The financing side of "when does the
// war end": oil, gas and coal exports are the backbone of Russia's war budget.
// The mirror image of the Kiel aid widget (aid TO Ukraine vs revenue TO Russia).
//
// Source: CREA Russia Fossil Tracker (Centre for Research on Energy and Clean
// Air), CC BY 4.0 — always credit. Real endpoint (public, no auth):
//   GET https://api.russiafossiltracker.com/v0/counter
//         ?format=json&aggregate_by=date&cumulate=true
//         &date_from=2022-02-24&pricing_scenario=default
//
// With no commodity/destination breakdown requested, each daily row is the
// grand total already aggregated across all commodities and destinations, and
// `cumulate=true` makes `value_eur` the running total since the invasion — so
// there is nothing to sum and no aggregate row to double-count. The latest
// value reconciles to CREA's published headline (~€1.07T, verified 2026-05-22).
//
// Like the CBR collector, this fetches the whole 2022→now series every run
// (one request, ~1.5k small rows) and the store dedupes on (metric,source,ts),
// so the cumulative line is complete from the first collect — no separate
// backfill script needed.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import { CreaCounterResponseSchema } from './crea.schema';

export const CREA_SOURCE = 'crea';
export const REVENUE_CUMULATIVE_METRIC = 'ru_fossil_revenue_eur_cumulative';

/** Invasion date — CREA's tracker counts from here. */
export const WAR_START = '2022-02-24';

export function counterUrl(dateFrom: string = WAR_START): string {
  return (
    'https://api.russiafossiltracker.com/v0/counter' +
    `?format=json&aggregate_by=date&cumulate=true&date_from=${dateFrom}` +
    '&pricing_scenario=default'
  );
}

/** Injectable HTTP layer so tests run offline. */
export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/** "2026-05-21T00:00:00" (or an ISO instant) → midnight-Z ISO, or undefined. */
export function dataDateToIsoUtc(raw: string): string | undefined {
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Map the cumulative-by-date payload to one snapshot per day (cumulative € to
 * Russia). Rows with a non-finite value or an unparseable date are skipped,
 * never fabricated. Exported for offline testing.
 */
export function mapCounter(raw: unknown): SnapshotInput[] {
  const { data } = CreaCounterResponseSchema.parse(raw);
  const out: SnapshotInput[] = [];
  for (const row of data) {
    const v = row.value_eur;
    if (v === null || !Number.isFinite(v)) continue;
    const ts = dataDateToIsoUtc(row.date);
    if (ts === undefined) continue;
    out.push({
      metric: REVENUE_CUMULATIVE_METRIC,
      source: CREA_SOURCE,
      ts,
      value: v,
      confidence: 1,
    });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function createCreaCollector(fetcher: JsonFetcher = defaultFetcher): Collector {
  return {
    name: CREA_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const raw = await fetcher(counterUrl());
      const snapshots = mapCounter(raw);
      if (snapshots.length === 0) {
        throw new Error('CREA counter returned no parseable daily rows');
      }
      return { snapshots };
    },
  };
}

export const creaCollector: Collector = createCreaCollector();
