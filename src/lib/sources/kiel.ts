// Kiel Ukraine Support Tracker collector — aid commitments curve.
//
// ── Chosen data source & why it is the most durable option ──────────────────
//
// Source: Kiel Institute — Ukraine Support Tracker (CC BY 4.0, no auth, free).
//   Landing: https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/
//   Topic:   https://www.kielinstitut.de/topics/war-against-ukraine/ukraine-support-tracker/
//
// REALITY: the Kiel Institute does NOT expose a clean public JSON/CSV REST API
// for this tracker. The dataset is released as a versioned Excel workbook whose
// direct download URL embeds a per-release UUID and a `Release_NN` counter
// (e.g. `…-Ukraine_Support_Tracker_Release_28.xlsx`). That URL rotates on every
// release, so a hard-coded spreadsheet URL is guaranteed to break. We checked
// the obvious durable mirrors (Our World in Data Chart Data API, HDX): none
// currently re-publish this time series under a stable slug, and the Kaggle
// mirror requires authentication (disqualified — must be freely fetchable).
//
// DECISION: the canonical Kiel dataset page is the most durable *origin*
// (authoritative, license-clear, long-lived domain), but its file URL is
// structurally unstable. So we treat the fetch URL as configuration:
//
//   • `KIEL_DATASET_URL` env var supplies the current CSV representation of the
//     "aid commitments over time" series. An operator updates this one value
//     when Kiel rotates the release URL or when a CSV export/mirror is chosen
//     — no code change, no redeploy of collector logic.
//   • The collector fetches text, parses CSV defensively (CSV → row objects →
//     Zod at the boundary), converts each month's headline figure to EUR using
//     that month's daily ECB reference rate (via the free, key-less Frankfurter
//     API which wraps ECB), and emits one snapshot per month with metric
//     `aid_commitments_eur`.
//   • If the source is unreachable, returns non-CSV, or drifts shape, the
//     collector throws a clear typed `KielSourceError`. Per the architecture
//     (see contract.ts `runCollector`) that failure is isolated: one widget
//     degrades, the page does not. We NEVER fabricate or interpolate numbers.
//
// REMAINING RISK (honest): the upstream representation is structurally fragile.
// Without an operator-supplied stable CSV URL/mirror this collector will fail
// (loudly, in isolation) rather than serve stale-but-real data. That is the
// correct trade-off for a transparency project: no number is better than a
// fabricated one.
//
// Per CLAUDE.md the FX helper is intentionally kept *in this file* (not in a
// shared module) so each collector owns its own ingest-time conversion and
// stays independently unit-testable with mocked fetchers.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchWithRetry, fetchJson } from './contract';
import {
  KielCommitmentsResponseSchema,
  FrankfurterResponseSchema,
  parseCsv,
  csvToCommitmentRows,
  type KielCommitmentRecord,
} from './kiel.schema';

/**
 * Default points at the canonical Kiel dataset landing page so a misconfigured
 * deployment fails with an obvious, source-attributable error instead of
 * silently doing nothing. Operators MUST override this with the current CSV
 * representation via the `KIEL_DATASET_URL` environment variable.
 */
export const KIEL_DEFAULT_URL =
  'https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/';

const FRANKFURTER_BASE = 'https://api.frankfurter.app';

export const AID_COMMITMENTS_METRIC = 'aid_commitments_eur';

/**
 * Typed error for an unreachable / unparseable Kiel source. The runner
 * (contract.ts) catches this and isolates the failure to this one widget.
 */
export class KielSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message); // ES2020 lib: Error has no options arg; set cause manually
    this.name = 'KielSourceError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Injectable fetchers so tests never hit the network. */
export interface KielFetchers {
  /** Returns the raw Kiel dataset body as text (CSV expected). */
  fetchKiel: (url: string) => Promise<string>;
  /** Returns the raw (unparsed) Frankfurter rate response for a date. */
  fetchRate: (url: string) => Promise<unknown>;
}

const defaultFetchers: KielFetchers = {
  fetchKiel: async (url) => {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new KielSourceError(`Kiel source HTTP ${res.status} for ${url}`);
    }
    return res.text();
  },
  fetchRate: (url) => fetchJson(url),
};

/** Resolve the configured Kiel dataset URL (env override, else default). */
function resolveKielUrl(env: Env): string {
  // Env is the platform contract; KIEL_DATASET_URL is operator configuration
  // and may be absent on a fresh deployment, hence the defensive index access.
  const fromEnv = (env as unknown as { KIEL_DATASET_URL?: unknown })
    .KIEL_DATASET_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return KIEL_DEFAULT_URL;
}

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
  // Cache rates per (date, currency, amount) so a multi-year extract makes at
  // most one FX request per distinct month rather than one per record.
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
    async run(env: Env): Promise<CollectorResult> {
      const url = resolveKielUrl(env);

      // 1. Fetch the configured CSV representation as text. Network / HTTP
      //    failures surface as a typed, source-attributable error.
      let body: string;
      try {
        body = await fetchers.fetchKiel(url);
      } catch (err) {
        if (err instanceof KielSourceError) throw err;
        throw new KielSourceError(
          `Kiel source unreachable (${url}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }

      // 2. Parse CSV → row objects defensively. An HTML error page, an XLSX
      //    binary, or a header-shape change all fail here, in isolation.
      let rawRows: unknown[];
      try {
        rawRows = csvToCommitmentRows(parseCsv(body));
      } catch (err) {
        throw new KielSourceError(
          `Kiel source unparseable as commitments CSV (${url}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }

      // 3. Zod-validate at the boundary. Downstream works with typed objects.
      const records = KielCommitmentsResponseSchema.parse(rawRows);
      const snapshots = await buildSnapshots(records, fetchers);
      return { snapshots };
    },
  };
}

export const kielCollector: Collector = createKielCollector();
