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
 * default uses the retry-aware shared `fetchJson`. This is the CURRENT-only
 * collector (one call to the all-currencies endpoint).
 */
export function createNbuCollector(
  fetcher: JsonFetcher = defaultFetcher
): Collector {
  return {
    name: 'nbu',
    run: (env: Env) => run(env, fetcher),
  };
}

// Full-war history. NBU's statdirectory exposes only a single-`date` form
// (verified live 2026-05-19: the `start`/`end` range form is ignored and
// returns today's rate), so we sample one request per MONTH from the war
// start to now — ~50 small public JSON calls, no auth, no rate-limit key.
const NBU_HISTORY_START_UTC = Date.UTC(2022, 0, 1);

/** Per-date single-currency endpoint for the 1st of the month at `ms`. */
export function nbuHistoryUrl(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(
    d.getUTCDate()
  )}`;
  return (
    'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange' +
    `?valcode=USD&date=${ymd}&json`
  );
}

/** First-of-month UTC markers across [startMs, nowMs], oldest-first. */
function monthlyMarkers(startMs: number, nowMs: number): number[] {
  const out: number[] = [];
  const s = new Date(startMs);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  for (;;) {
    const ms = Date.UTC(y, m, 1);
    if (ms > nowMs) break;
    out.push(ms);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/**
 * Monthly UAH-per-USD history. One request per month; a month with no
 * official rate (weekend/holiday 1st, or NBU gap) is skipped — never
 * fabricated. Per-month fetch/parse errors are isolated; throws only if
 * EVERY month failed, so the source stays failure-isolated at the runner.
 */
export async function collectNbuHistory(
  fromMs: number,
  nowMs: number,
  fetcher: JsonFetcher = defaultFetcher
): Promise<CollectorResult> {
  const markers = monthlyMarkers(fromMs, nowMs);
  const snapshots: SnapshotInput[] = [];
  let attempted = 0;
  let failed = 0;

  for (const ms of markers) {
    attempted++;
    try {
      const raw = await fetcher(nbuHistoryUrl(ms));
      const rows = NbuExchangeResponseSchema.parse(raw);
      const usd = rows.find((r) => r.cc.toUpperCase() === 'USD');
      if (!usd || !Number.isFinite(usd.rate) || usd.rate <= 0) continue;
      snapshots.push({
        metric: NBU_UAH_USD_METRIC,
        source: 'nbu',
        ts: nbuDateToIsoUtc(usd.exchangedate),
        value: usd.rate,
        raw_blob: JSON.stringify(usd),
        confidence: 1,
      });
    } catch {
      failed++; // bad/empty month must not abort the whole series
    }
  }

  if (attempted > 0 && failed === attempted) {
    throw new Error('NBU history: every monthly request failed');
  }
  return { snapshots };
}

export const nbuCollector: Collector = {
  name: 'nbu',
  async run(env: Env): Promise<CollectorResult> {
    // History (monthly, war start → now) is the substantive series; the
    // current all-currencies call adds today's freshest point. Merge and
    // de-dupe on ts (filestore also dedupes on (metric,source,ts)).
    const hist = await collectNbuHistory(
      NBU_HISTORY_START_UTC,
      Date.now()
    );
    let current: CollectorResult = { snapshots: [] };
    try {
      current = await run(env, defaultFetcher);
    } catch {
      // The historical series alone is sufficient; a transient current-feed
      // failure must not drop the already-fetched history.
    }
    const byTs = new Map<string, SnapshotInput>();
    for (const s of [...hist.snapshots, ...current.snapshots]) {
      byTs.set(s.ts, s);
    }
    return { snapshots: [...byTs.values()] };
  },
};
