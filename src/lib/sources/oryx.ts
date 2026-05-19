// Oryx collector — visually-confirmed equipment losses for Russia and
// Ukraine (cumulative count over time). Honest by construction: every row
// is a photo-attributed loss; we never estimate or fabricate. Oryx is
// CC BY-NC — fine here (this project is non-commercial and credits it).
//
// Source: the maintained machine-readable mirror of Oryx,
//   https://raw.githubusercontent.com/scarnecchia/oryx_data/main/totals_by_system.csv
// (one row per confirmed piece of equipment). The cumulative row count per
// country per date is the same headline Oryx itself reports.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchText } from './contract';
import { OryxRowSchema } from './oryx.schema';

export const ORYX_SOURCE = 'oryx';
export const RU_LOSS_METRIC = 'ru_equipment_losses';
export const UA_LOSS_METRIC = 'ua_equipment_losses';
export const ORYX_URL =
  'https://raw.githubusercontent.com/scarnecchia/oryx_data/main/totals_by_system.csv';

export class OryxSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OryxSourceError';
  }
}

/** Injected for tests; defaults to the shared retry-aware text fetch. */
export type TextFetcher = (url: string) => Promise<string>;
const defaultFetcher: TextFetcher = (url) => fetchText(url);

/** RFC-4180-ish single-line CSV field split (handles quoted commas/quotes). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const COUNTRY_METRIC: Record<string, string> = {
  Russia: RU_LOSS_METRIC,
  Ukraine: UA_LOSS_METRIC,
};

/**
 * Parse the Oryx CSV into a cumulative per-country loss series — one
 * snapshot per date that has at least one new confirmed loss, the value
 * being the running total of confirmed losses up to and including that day.
 * Exported for offline unit testing of the pure mapping.
 */
export function mapOryxCsv(csv: string): SnapshotInput[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    throw new OryxSourceError('Oryx CSV: empty or header-only');
  }
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const ci = header.indexOf('country');
  const di = header.indexOf('date_recorded');
  if (ci === -1 || di === -1) {
    throw new OryxSourceError(
      'Oryx CSV: missing country/date_recorded columns'
    );
  }

  // country -> (YYYY-MM-DD -> count of confirmed losses recorded that day)
  const perDay = new Map<string, Map<string, number>>();
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const parsed = OryxRowSchema.safeParse({
      country: (f[ci] ?? '').trim(),
      date_recorded: (f[di] ?? '').trim(),
    });
    if (!parsed.success) continue;
    const { country, date_recorded } = parsed.data;
    const metric = COUNTRY_METRIC[country];
    if (!metric) continue; // not a belligerent row
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_recorded)) continue;
    let day = perDay.get(metric);
    if (!day) {
      day = new Map();
      perDay.set(metric, day);
    }
    day.set(date_recorded, (day.get(date_recorded) ?? 0) + 1);
  }

  const out: SnapshotInput[] = [];
  for (const [metric, day] of perDay) {
    let cum = 0;
    for (const date of [...day.keys()].sort()) {
      cum += day.get(date) as number;
      out.push({
        metric,
        source: ORYX_SOURCE,
        ts: `${date}T00:00:00.000Z`,
        value: cum,
        confidence: 1,
        raw_blob: JSON.stringify({ date, cumulative: cum }),
      });
    }
  }
  if (out.length === 0) {
    throw new OryxSourceError('Oryx CSV: no Russia/Ukraine rows parsed');
  }
  return out;
}

/**
 * Build the Oryx collector. The fetcher is injectable for offline tests.
 * Network/parse failure surfaces as a typed {@link OryxSourceError} so the
 * runner keeps it failure-isolated (one bad source, not the whole run).
 */
export function createOryxCollector(
  fetcher: TextFetcher = defaultFetcher
): Collector {
  return {
    name: ORYX_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      let csv: string;
      try {
        csv = await fetcher(ORYX_URL);
      } catch (err) {
        throw new OryxSourceError(
          `Oryx fetch failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return { snapshots: mapOryxCsv(csv) };
    },
  };
}

export const oryxCollector: Collector = createOryxCollector();
