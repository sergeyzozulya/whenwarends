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
//
// Live verification (2026-05-18): the failure was twofold:
//   1. `URLSearchParams.toString()` encodes spaces as `+`, which the GDELT DOC
//      2.0 API rejects (the `query` grammar needs literal-space => `%20`). We
//      now percent-encode each param value explicitly.
//   2. GDELT enforces "one request every 5 seconds" and answers a violation
//      with a *plain-text* 429 body (content-type absent), so a blind
//      `res.json()` throws an opaque parse error. We now fetch the two modes
//      *sequentially* with spacing, send a descriptive User-Agent, and verify
//      the response is JSON before parsing — surfacing a clear typed error so
//      this source stays failure-isolated rather than crashing the run.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchWithRetry } from './contract';
import {
  GdeltTimelineResponseSchema,
  type GdeltTimelineResponse,
} from './gdelt.schema';

const SOURCE = 'gdelt';

const QUERY =
  '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng';

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

// GDELT asks for "one request every 5 seconds". We space the two mode fetches a
// touch beyond that to stay clear of the limiter (and its plain-text 429).
const RATE_LIMIT_GAP_MS = 6000;

// GDELT has no auth/key; a descriptive UA is the polite ask in their docs and
// avoids being treated as an anonymous scraper.
const USER_AGENT =
  'whenwarends-collector/1.0 (+https://whenwarends.org; non-commercial, CC BY 4.0 attribution)';

/** Build a fully percent-encoded GDELT DOC 2.0 timeline URL (spaces => %20). */
function buildUrl(mode: 'timelinevol' | 'timelinetone'): string {
  const qs = [
    ['query', QUERY],
    ['mode', mode],
    ['timespan', '12months'],
    ['format', 'json'],
  ]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${BASE}?${qs}`;
}

/** Raised when GDELT answers with non-JSON (rate-limit text, HTML error). */
export class GdeltResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GdeltResponseError';
  }
}

/** A fetcher returning already-decoded JSON. Injectable for tests. */
export type JsonFetcher = (url: string) => Promise<unknown>;

/**
 * Default fetcher. Uses the frozen retry/backoff helper (with UA via init),
 * then guards the body: GDELT signals a rate-limit/error as plain text or
 * HTML, not JSON, so we check content-type and parse defensively, throwing a
 * typed {@link GdeltResponseError} instead of letting JSON.parse crash opaquely.
 */
const defaultFetcher: JsonFetcher = async (url) => {
  const res = await fetchWithRetry(url, {
    init: {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    },
  });

  const body = await res.text();

  if (!res.ok) {
    throw new GdeltResponseError(
      `GDELT HTTP ${res.status} for ${url}: ${body.slice(0, 200).trim()}`
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  const looksJson =
    contentType.includes('json') || /^\s*[[{]/.test(body);
  if (!looksJson) {
    // Most commonly the plain-text rate-limit notice ("Please limit requests
    // to one every 5 seconds...") or an HTML error page.
    throw new GdeltResponseError(
      `GDELT returned non-JSON (content-type "${contentType}"): ${body
        .slice(0, 200)
        .trim()}`
    );
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new GdeltResponseError(
      `GDELT returned malformed JSON: ${body.slice(0, 200).trim()}`
    );
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

async function collect(
  fetcher: JsonFetcher,
  paceMs: number
): Promise<CollectorResult> {
  // Sequential, not Promise.all: GDELT rate-limits to ~1 req / 5s and answers a
  // burst with a plain-text 429. Inter-request spacing keeps us under the cap.
  // `paceMs` is 0 for the injected test fetcher (no real network, no waiting).
  const volRaw = await fetcher(buildUrl('timelinevol'));
  if (paceMs > 0) await sleep(paceMs);
  const toneRaw = await fetcher(buildUrl('timelinetone'));

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
    return collect(defaultFetcher, RATE_LIMIT_GAP_MS);
  },
  runWith(fetcher: JsonFetcher): Promise<CollectorResult> {
    // Tests inject a synchronous fetcher; no network => no pacing delay.
    return collect(fetcher, 0);
  },
};
