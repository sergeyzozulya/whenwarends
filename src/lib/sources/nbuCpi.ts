// NBU collector — Ukraine national headline consumer-price inflation (% y/y),
// MONTHLY, full war period.
//
// Real endpoint (public, no auth):
//   GET https://bank.gov.ua/NBUStatService/v1/statdirectory/inflation
//       ?json&period=m&date=YYYYMM
//
// One request returns every price series for a single month; the national
// headline CPI y/y is the unique row decoded in nbuCpi.schema.ts:
//   id_api="prices_price_cpi_", mcrd081="Total", ku=null, mcrk110="NULL",
//   tzep="PCCM_", freq="M".
//
// Like the NBU FX history collector, the statdirectory takes only a single
// `date`, so we sample one request per MONTH from the war start to now
// (~50 small public JSON calls). A month with no published headline row is
// skipped — never fabricated. Per-month failures are isolated; the collector
// throws only if EVERY month failed (so the runner keeps it failure-isolated).

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  NbuCpiResponseSchema,
  type NbuCpiRow,
} from './nbuCpi.schema';

export const UA_CPI_YOY_METRIC = 'ua_cpi_yoy';

/** Injected for tests; defaults to the shared retry-aware JSON fetch. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

const NBU_CPI_HISTORY_START_UTC = Date.UTC(2022, 0, 1);

/** Monthly inflation endpoint for the calendar month containing `ms`. */
export function nbuCpiUrl(ms: number): string {
  const d = new Date(ms);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}`;
  return (
    'https://bank.gov.ua/NBUStatService/v1/statdirectory/inflation' +
    `?json&period=m&date=${ym}`
  );
}

/** The single national-headline CPI y/y row, or null if absent that month. */
export function selectHeadline(rows: NbuCpiRow[]): NbuCpiRow | null {
  const hits = rows.filter(
    (r) =>
      r.id_api === 'prices_price_cpi_' &&
      r.mcrd081 === 'Total' &&
      r.ku === null &&
      r.mcrk110 === 'NULL' &&
      r.tzep === 'PCCM_' &&
      r.freq === 'M' &&
      r.value !== null &&
      Number.isFinite(r.value)
  );
  return hits.length === 1 ? hits[0] : null;
}

/** "YYYYMMDD" → ISO-8601 UTC midnight; null on a malformed/impossible date. */
export function nbuCpiDtToIsoUtc(dt: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dt.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
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
 * Monthly Ukraine headline CPI (% y/y). One request per month; a month with
 * no unique headline row is skipped (never invented). Per-month errors are
 * isolated; throws only if every attempted month failed.
 */
export async function collectNbuCpiHistory(
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
      const raw = await fetcher(nbuCpiUrl(ms));
      const rows = NbuCpiResponseSchema.parse(raw);
      const hit = selectHeadline(rows);
      if (!hit) continue;
      const ts = nbuCpiDtToIsoUtc(hit.dt);
      if (ts === null) continue;
      snapshots.push({
        metric: UA_CPI_YOY_METRIC,
        source: 'nbu',
        ts,
        value: hit.value as number, // selectHeadline guarantees finite number
        raw_blob: JSON.stringify(hit),
        confidence: 1,
      });
    } catch {
      failed++; // a bad/empty month must not abort the whole series
    }
  }

  if (attempted > 0 && failed === attempted) {
    throw new Error('NBU CPI history: every monthly request failed');
  }
  return { snapshots };
}

export const nbuCpiCollector: Collector = {
  name: 'nbu-cpi',
  run: (_env: Env): Promise<CollectorResult> =>
    collectNbuCpiHistory(NBU_CPI_HISTORY_START_UTC, Date.now()),
};
