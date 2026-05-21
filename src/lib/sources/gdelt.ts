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

// Full-war history. GDELT DOC 2.0 serves explicit date ranges (verified live
// 2026-05-19: a 2022 startdatetime/enddatetime returns real daily data) but
// rejects very long single ranges ("contact … for larger queries"). So we
// fetch in YEARLY windows — each ~365 day-resolution points — paced under the
// 1-req/5s limiter. The old `timespan=12m` is exactly why intensity history
// only reached back ~12 months; this replaces it.
const HISTORY_START_UTC = Date.UTC(2022, 0, 1); // war run-up; GDELT has data

/** Date(ms) → GDELT's `YYYYMMDDHHMMSS` (UTC) start/enddatetime grammar. */
export function fmtGdelt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Chronological yearly {start,end} windows spanning [startMs, endMs). */
export function gdeltWindows(
  startMs: number,
  endMs: number
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let s = startMs;
  while (s < endMs) {
    const nextYear = Date.UTC(new Date(s).getUTCFullYear() + 1, 0, 1);
    const e = Math.min(nextYear, endMs);
    out.push({ start: fmtGdelt(s), end: fmtGdelt(e) });
    s = e;
  }
  return out;
}

/** Build a fully percent-encoded GDELT DOC 2.0 timeline URL (spaces => %20). */
function buildUrl(
  mode: 'timelinevol' | 'timelinetone',
  startdatetime: string,
  enddatetime: string
): string {
  const qs = [
    ['query', QUERY],
    ['mode', mode],
    ['startdatetime', startdatetime],
    ['enddatetime', enddatetime],
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
// GDELT enforces ~1 request / 5s per IP and answers a violation with a
// plain-text notice (HTTP 429, or 200 + "Please limit requests..."). The
// generic fast backoff in fetchWithRetry stays well under 5s, so it cannot
// clear this limiter. For a once-weekly job latency is irrelevant, so on a
// detected rate-limit we wait past the window and retry a few times before
// giving up (typed error, failure-isolated).
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RATE_RETRY_ATTEMPTS = 4;
const RATE_RETRY_WAIT_MS = 7000;

const isRateLimited = (status: number, body: string): boolean =>
  status === 429 || /limit requests|one every \d+ seconds/i.test(body);

export const defaultFetcher: JsonFetcher = async (url) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(url, {
      // GDELT is genuinely slow — relevance-ranked artlist or multi-year
      // timeline windows routinely take 20–40s. The 15s default aborts mid-
      // flight and surfaces as an opaque "fetch failed". This is a weekly job,
      // so trade latency for reliability with a long per-attempt timeout.
      timeoutMs: 60000,
      init: {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      },
    });
    const body = await res.text();

    if (isRateLimited(res.status, body)) {
      if (attempt < RATE_RETRY_ATTEMPTS) {
        await sleep(RATE_RETRY_WAIT_MS);
        continue;
      }
      throw new GdeltResponseError(
        `GDELT rate-limited after ${RATE_RETRY_ATTEMPTS + 1} attempts for ${url}: ${body
          .slice(0, 200)
          .trim()}`
      );
    }

    if (!res.ok) {
      throw new GdeltResponseError(
        `GDELT HTTP ${res.status} for ${url}: ${body.slice(0, 200).trim()}`
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    const looksJson = contentType.includes('json') || /^\s*[[{]/.test(body);
    if (!looksJson) {
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
  }
};

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
  metric: string
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
        // Per-point blob only. With full-war history a per-response blob
        // would repeat the entire timeline on every row and explode the
        // ndjson; the point itself is the auditable raw datum.
        raw_blob: JSON.stringify({ date: point.date, value: point.value }),
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
  // Recurring path: recent edge only, 2 requests, STRICT (a bad/rate-limited
  // response throws → runner marks the source failed, failure-isolated).
  // `paceMs` is 0 for the injected test fetcher (no network, no waiting).
  // Recurring weekly job: only the recent edge. History is immutable and
  // already in the snapshot store; the one-time backfill (collectGdeltHistory)
  // handles 2022→. One window keeps the weekly run to 2 requests, clear of
  // GDELT's 1-req/5s limiter — cramming full history here is what rate-limited
  // and failed it.
  const RECENT_DAYS = 120;
  const nowMs = Date.now();
  const wins = [
    {
      start: fmtGdelt(nowMs - RECENT_DAYS * 24 * 3600 * 1000),
      end: fmtGdelt(nowMs),
    },
  ];

  // (metric,ts)-dedupe, keep first: window boundaries can repeat an edge
  // point, and a stubbed test fetcher returns the same payload per window.
  const byKey = new Map<string, SnapshotInput>();
  const modes: { mode: 'timelinevol' | 'timelinetone'; metric: string }[] = [
    { mode: 'timelinevol', metric: 'conflict_intensity' },
    { mode: 'timelinetone', metric: 'conflict_tone' },
  ];

  for (const { mode, metric } of modes) {
    for (const w of wins) {
      if (paceMs > 0) await sleep(paceMs);
      const raw = await fetcher(buildUrl(mode, w.start, w.end));
      const parsed = GdeltTimelineResponseSchema.parse(raw);
      for (const s of seriesToSnapshots(parsed, metric)) {
        const key = `${s.metric} ${s.ts}`;
        if (!byKey.has(key)) byKey.set(key, s);
      }
    }
  }

  return { snapshots: [...byKey.values()] };
}

/**
 * One-time historical backfill: yearly windows from the war start to now.
 * RESILIENT — a failed window (rate-limit, transport, or garbage) is logged
 * and skipped so a single hiccup never discards the years that did succeed;
 * throws only if EVERY window of EVERY mode failed. Paces generously: this is
 * run once, manually, from a non-rate-limited IP (latency is irrelevant). The
 * recurring weekly `collect` deliberately does NOT do this.
 */
export async function collectGdeltHistory(
  fetcher: JsonFetcher = defaultFetcher,
  paceMs = RATE_LIMIT_GAP_MS
): Promise<CollectorResult> {
  const wins = gdeltWindows(HISTORY_START_UTC, Date.now());
  const modes: { mode: 'timelinevol' | 'timelinetone'; metric: string }[] = [
    { mode: 'timelinevol', metric: 'conflict_intensity' },
    { mode: 'timelinetone', metric: 'conflict_tone' },
  ];
  const byKey = new Map<string, SnapshotInput>();
  let attempted = 0;
  let failed = 0;

  for (const { mode, metric } of modes) {
    for (const w of wins) {
      attempted++;
      if (paceMs > 0) await sleep(paceMs);
      try {
        const raw = await fetcher(buildUrl(mode, w.start, w.end));
        const parsed = GdeltTimelineResponseSchema.parse(raw);
        for (const s of seriesToSnapshots(parsed, metric)) {
          const key = `${s.metric} ${s.ts}`;
          if (!byKey.has(key)) byKey.set(key, s);
        }
      } catch (err) {
        failed++;
        console.error(
          `gdelt-history: skip ${mode} ${w.start}-${w.end}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  if (byKey.size === 0 && attempted > 0 && failed === attempted) {
    throw new GdeltResponseError(
      `GDELT history: all ${attempted} windowed requests failed`
    );
  }
  return { snapshots: [...byKey.values()] };
}

/**
 * The rate-limit-aware GDELT JSON fetcher, shared with the artlist collector
 * (gdeltArticles.ts) so both hit GDELT through the same 1-req/5s-safe path.
 */
export const gdeltJsonFetcher: JsonFetcher = defaultFetcher;

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
