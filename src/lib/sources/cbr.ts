// Russian CBR collector — RUB FX rate (RUB per USD) for the macro widgets.
//
// Real endpoint (public JSON mirror of the official CBR XML feed, no auth,
// daily refresh; see cbr.schema.ts for the upstream and the full shape):
//   GET https://www.cbr-xml-daily.ru/daily_json.js
//
// Notes on the real API:
//   - Returned `Value` is rubles per `Nominal` units of the currency, so the
//     RUB-per-USD rate is `USD.Value / USD.Nominal` (Nominal is 1 for USD
//     today, but we divide unconditionally so other currencies stay correct
//     if added later).
//   - `Date` is ISO-8601 with a Moscow (+03:00) offset. We re-emit it through
//     `new Date(...).toISOString()` so the stored `ts` is canonical UTC
//     ISO-8601 regardless of upstream formatting.
//   - Reserves are NOT exposed by this daily FX endpoint (CBR publishes
//     international reserves on a separate weekly XML feed). Reserves are
//     therefore intentionally out of scope here; only the FX metric is
//     emitted. Documented so the omission is a deliberate decision, not a gap.
//   - Correctness is proven entirely by mocked tests — this collector has no
//     live dependency in CI.
//
// Mapping:
//   - SnapshotInput: metric 'rub_usd_rate', source 'cbr',
//     value = RUB per USD (Value / Nominal), ts = UTC ISO-8601 from `Date`.

import { fetchJson } from './contract';
import { CbrDailySchema } from './cbr.schema';
import type {
  Collector,
  CollectorResult,
  Env,
  SnapshotInput,
} from '../types';

export const CBR_DAILY_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

export const SOURCE = 'cbr' as const;
export const METRIC_RUB_USD_RATE = 'rub_usd_rate' as const;

/** Injectable fetcher so unit tests can supply a mocked CBR payload. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/** Normalise any ISO-8601 input to canonical UTC ISO-8601, or null. */
function toIsoUtc(value: string): string | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Pull the CBR daily rates, Zod-parse at the boundary, and map the USD entry
 * to a single RUB-per-USD snapshot. `fetcher` is injectable for mock tests.
 * Throws on a missing/garbage payload or a missing USD entry — the runner
 * captures the error per-source (see contract.ts), so one bad source degrades
 * one widget, not the whole cron run.
 */
export async function collectCbr(
  fetcher: JsonFetcher = defaultFetcher
): Promise<CollectorResult> {
  const raw = await fetcher(CBR_DAILY_URL);
  // Parse at the boundary: downstream code works only with typed objects.
  const parsed = CbrDailySchema.parse(raw);

  const usd = parsed.Valute.USD;
  if (!usd) {
    throw new Error('CBR payload missing USD valute entry');
  }

  const ts = toIsoUtc(parsed.Date);
  if (ts === null) {
    throw new Error(`CBR payload has unparseable Date: ${parsed.Date}`);
  }

  // RUB per 1 USD. Nominal is schema-guaranteed a positive integer, so this
  // division is always a finite number.
  const rubPerUsd = usd.Value / usd.Nominal;

  const snapshot: SnapshotInput = {
    metric: METRIC_RUB_USD_RATE,
    source: SOURCE,
    ts,
    value: rubPerUsd,
    raw_blob: JSON.stringify(usd),
    confidence: 1,
  };

  return { snapshots: [snapshot] };
}

export const cbrCollector: Collector = {
  name: SOURCE,
  async run(_env: Env): Promise<CollectorResult> {
    return collectCbr();
  },
};
