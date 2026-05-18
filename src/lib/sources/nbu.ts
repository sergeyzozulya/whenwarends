// National Bank of Ukraine (NBU) collector — official UAH/USD exchange rate.
//
// Real endpoint (public, no auth required):
//   GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json
//
// The statdirectory exchange endpoint returns the official daily rates for all
// tracked currencies. We select the USD row (ISO-4217 alpha "USD", numeric 840)
// and emit one snapshot for the `uah_usd_rate` metric (UAH per 1 USD).
//
// This endpoint exposes FX rates only — it carries no reserves data — so no
// reserves metric is emitted. NBU international-reserves figures live on a
// separate macro series and are out of scope for this collector.
//
// `exchangedate` arrives as dd.mm.yyyy (e.g. "16.05.2026"). NBU publishes one
// official rate per calendar day; we treat that calendar date as midnight UTC
// (ISO-8601, e.g. "2026-05-16T00:00:00.000Z").

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import { NbuExchangeResponseSchema } from './nbu.schema';

export const NBU_EXCHANGE_URL =
  'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';

export const NBU_UAH_USD_METRIC = 'uah_usd_rate';

/** Injected for tests; defaults to the shared retry-aware JSON fetch. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/**
 * Convert NBU's dd.mm.yyyy date into an ISO-8601 UTC timestamp at midnight.
 * Throws on malformed input so a bad date surfaces as a collector failure
 * rather than a silently wrong snapshot.
 */
export function nbuDateToIsoUtc(exchangedate: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(exchangedate.trim());
  if (!match) {
    throw new Error(`unexpected NBU exchangedate format: "${exchangedate}"`);
  }
  const [, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Round-trip check rejects impossible dates like 31.02.2026.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`invalid NBU exchangedate: "${exchangedate}"`);
  }
  return date.toISOString();
}

async function run(_env: Env, fetcher: JsonFetcher): Promise<CollectorResult> {
  const raw = await fetcher(NBU_EXCHANGE_URL);
  const rates = NbuExchangeResponseSchema.parse(raw);

  const usd = rates.find((r) => r.cc.toUpperCase() === 'USD');
  if (!usd) {
    throw new Error('NBU exchange response did not include a USD rate');
  }
  if (!Number.isFinite(usd.rate) || usd.rate <= 0) {
    throw new Error(`NBU USD rate is not a positive number: ${usd.rate}`);
  }

  const snapshot: SnapshotInput = {
    metric: NBU_UAH_USD_METRIC,
    source: 'nbu',
    ts: nbuDateToIsoUtc(usd.exchangedate),
    value: usd.rate,
    raw_blob: JSON.stringify(usd),
    confidence: 1,
  };

  return { snapshots: [snapshot] };
}

/**
 * Build an NBU collector. Pass a fetcher in tests to inject mock JSON; the
 * default uses the retry-aware shared `fetchJson`.
 */
export function createNbuCollector(
  fetcher: JsonFetcher = defaultFetcher
): Collector {
  return {
    name: 'nbu',
    run: (env: Env) => run(env, fetcher),
  };
}

export const nbuCollector: Collector = createNbuCollector();
