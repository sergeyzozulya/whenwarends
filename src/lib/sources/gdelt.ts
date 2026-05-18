// GDELT 2.0 collector — conflict intensity / event density / tone for the
// Russia–Ukraine war.
//
// Data source: GDELT DOC 2.0 API (CC BY 4.0, no auth, no rate-limit key).
// We pull two timeline series and emit one snapshot per data point:
//
//   metric 'conflict_intensity'  <- mode=timelinevol  (% of monitored news
//                                    matching the war query; event-density proxy)
//   metric 'conflict_tone'       <- mode=timelinetone  (avg article tone;
//                                    more negative = more conflictual coverage)
//
// Endpoint + query are documented in gdelt.schema.ts. We parse the JSON at the
// boundary with Zod, then map to typed SnapshotInput[]. The fetcher is
// injectable so unit tests run fully offline against mocked GDELT JSON.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  GdeltTimelineResponseSchema,
  type GdeltTimelineResponse,
} from './gdelt.schema';

const SOURCE = 'gdelt';

const QUERY =
  '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng';

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

function buildUrl(mode: 'timelinevol' | 'timelinetone'): string {
  const params = new URLSearchParams({
    query: QUERY,
    mode,
    timespan: '12months',
    format: 'json',
  });
  return `${BASE}?${params.toString()}`;
}

/** A fetcher returning already-decoded JSON. Injectable for tests. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/**
 * Normalize a GDELT timeline date to an ISO-8601 UTC string.
 * Accepts the observed variants:
 *   - `YYYYMMDDHHMMSS`            (e.g. 20260517000000)
 *   - `YYYYMMDDTHHMMSSZ`         (e.g. 20260517T120000Z)
 *   - already-ISO `YYYY-MM-DDTHH:MM:SSZ`
 * Returns null when the input cannot be interpreted as a valid date.
 */
export function normalizeGdeltDate(raw: string): string | null {
  const s = raw.trim();

  // Compact basic form, optionally with a `T` separator and trailing `Z`.
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})Z?)?$/.exec(
    s
  );
  if (compact) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = compact;
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  // Anything else: defer to Date parsing (covers already-ISO inputs).
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function seriesToSnapshots(
  parsed: GdeltTimelineResponse,
  metric: string,
  rawBlob: string
): SnapshotInput[] {
  const out: SnapshotInput[] = [];
  for (const series of parsed.timeline) {
    for (const point of series.data) {
      const ts = normalizeGdeltDate(point.date);
      if (ts === null) continue; // skip un-parseable timestamps
      if (!Number.isFinite(point.value)) continue;
      out.push({
        metric,
        source: SOURCE,
        ts,
        value: point.value,
        raw_blob: rawBlob,
        // GDELT global news monitoring is dense and stable; treat the
        // normalized timeline as high-confidence.
        confidence: 0.9,
      });
    }
  }
  return out;
}

async function collect(fetcher: JsonFetcher): Promise<CollectorResult> {
  const [volRaw, toneRaw] = await Promise.all([
    fetcher(buildUrl('timelinevol')),
    fetcher(buildUrl('timelinetone')),
  ]);

  const vol = GdeltTimelineResponseSchema.parse(volRaw);
  const tone = GdeltTimelineResponseSchema.parse(toneRaw);

  const snapshots: SnapshotInput[] = [
    ...seriesToSnapshots(vol, 'conflict_intensity', JSON.stringify(volRaw)),
    ...seriesToSnapshots(tone, 'conflict_tone', JSON.stringify(toneRaw)),
  ];

  return { snapshots };
}

export interface GdeltCollector extends Collector {
  /** Test seam: run with an injected JSON fetcher (no network). */
  runWith(fetcher: JsonFetcher): Promise<CollectorResult>;
}

export const gdeltCollector: GdeltCollector = {
  name: SOURCE,
  run(_env: Env): Promise<CollectorResult> {
    return collect(defaultFetcher);
  },
  runWith(fetcher: JsonFetcher): Promise<CollectorResult> {
    return collect(fetcher);
  },
};
