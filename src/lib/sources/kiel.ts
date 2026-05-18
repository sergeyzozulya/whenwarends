// Kiel Ukraine Support Tracker collector — aid commitments curve.
//
// Source: Kiel Institute Ukraine Support Tracker (CC BY 4.0, no auth).
// See kiel.schema.ts for the documented JSON contract and source URLs.
//
// This collector pulls the monthly aid-commitment extract, converts each
// month's headline figure to EUR using that month's daily ECB reference rate
// (via the free, key-less Frankfurter API which wraps ECB), and emits one
// snapshot per month with metric `aid_commitments_eur`.
//
// Per CLAUDE.md the FX helper is intentionally kept *in this file* (not in a
// shared module) so each collector owns its own ingest-time conversion and
// stays independently unit-testable with mocked fetchers.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  KielCommitmentsResponseSchema,
  FrankfurterResponseSchema,
  type KielCommitmentRecord,
} from './kiel.schema';

const KIEL_URL =
  'https://data.ifw-kiel.de/ukraine-support-tracker/commitments-by-month.json';

const FRANKFURTER_BASE = 'https://api.frankfurter.app';

export const AID_COMMITMENTS_METRIC = 'aid_commitments_eur';

/** Injectable fetchers so tests never hit the network. */
export interface KielFetchers {
  /** Returns the raw (unparsed) Kiel commitments extract. */
  fetchKiel: (url: string) => Promise<unknown>;
  /** Returns the raw (unparsed) Frankfurter rate response for a date. */
  fetchRate: (url: string) => Promise<unknown>;
}

const defaultFetchers: KielFetchers = {
  fetchKiel: (url) => fetchJson(url),
  fetchRate: (url) => fetchJson(url),
};

/**
 * Normalise a Kiel `month` string ("2024-03" or a full ISO date) to the first
 * instant of that UTC month as an ISO-8601 string. Throws on unparseable input
 * so a garbage row fails loudly at the boundary rather than silently skewing
 * the curve.
 */
export function monthToUtcIso(month: string): string {
  const m = month.trim();
  // Match YYYY-MM or YYYY-MM-DD (optionally with time); we only need year+month.
  const match = /^(\d{4})-(\d{2})/.exec(m);
  if (!match) throw new Error(`unparseable Kiel month: ${month}`);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) throw new Error(`invalid month value: ${month}`);
  return new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0)).toISOString();
}

/** The UTC calendar date (YYYY-MM-DD) we ask Frankfurter for: month start. */
function rateDateFor(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Daily ECB rate via Frankfurter. Converts an amount in `from` currency to
 * EUR for the given UTC date. EUR amounts pass through untouched (no request).
 * 1 EUR = rates[from] of `from`, so EUR = amount / rates[from].
 */
async function toEur(
  amount: number,
  from: 'EUR' | 'USD',
  utcDate: string,
  fetchRate: KielFetchers['fetchRate']
): Promise<number> {
  if (from === 'EUR') return amount;
  const url = `${FRANKFURTER_BASE}/${utcDate}?from=EUR&to=${from}`;
  const raw = await fetchRate(url);
  const parsed = FrankfurterResponseSchema.parse(raw);
  const rate = parsed.rates[from];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`missing/invalid FX rate EUR->${from} for ${utcDate}`);
  }
  return amount / rate;
}

async function buildSnapshots(
  records: KielCommitmentRecord[],
  fetchers: KielFetchers
): Promise<SnapshotInput[]> {
  // Cache rates per (date, currency) so a multi-year extract makes at most one
  // FX request per distinct month rather than one per record.
  const rateCache = new Map<string, Promise<number>>();
  const snapshots: SnapshotInput[] = [];

  for (const rec of records) {
    const ts = monthToUtcIso(rec.month);
    const utcDate = rateDateFor(ts);
    const key = `${utcDate}|${rec.currency}|${rec.amount}`;
    let valuePromise = rateCache.get(key);
    if (!valuePromise) {
      valuePromise = toEur(
        rec.amount,
        rec.currency,
        utcDate,
        fetchers.fetchRate
      );
      rateCache.set(key, valuePromise);
    }
    const eur = await valuePromise;
    snapshots.push({
      metric: AID_COMMITMENTS_METRIC,
      source: 'kiel',
      ts,
      value: eur,
      raw_blob: JSON.stringify(rec),
      confidence: 1,
    });
  }

  return snapshots;
}

/**
 * Factory so tests can inject mocked fetchers. Production code uses the
 * exported `kielCollector` singleton below.
 */
export function createKielCollector(
  fetchers: KielFetchers = defaultFetchers
): Collector {
  return {
    name: 'kiel',
    async run(_env: Env): Promise<CollectorResult> {
      const rawKiel = await fetchers.fetchKiel(KIEL_URL);
      const records = KielCommitmentsResponseSchema.parse(rawKiel);
      const snapshots = await buildSnapshots(records, fetchers);
      return { snapshots };
    },
  };
}

export const kielCollector: Collector = createKielCollector();
