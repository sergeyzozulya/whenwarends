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
// Live verification (2026-05-18): the failure was threefold:
//   1. `URLSearchParams.toString()` encodes spaces as `+`, which the GDELT DOC
//      2.0 API rejects (the `query` grammar needs literal-space => `%20`). We
//      now percent-encode each param value explicitly.
//   2. GDELT enforces "one request every 5 seconds" PER IP, counted across all
//      endpoints (timeline + artlist news) and retries — and answers a
//      violation with a *plain-text* 429 body (content-type absent), so a blind
//      `res.json()` throws an opaque parse error. A single process-wide pacer
//      (createGdeltPacer) now serializes every GDELT request ≥5s apart — so the
//      news request and retries can't collide with the timeline modes — and we
//      send a descriptive User-Agent and verify the response is JSON before
//      parsing, surfacing a clear typed error so this source stays
//      failure-isolated rather than crashing the run.
//   3. GDELT also refuses or drops the connection under load — which surfaces
//      as Node's opaque `TypeError: fetch failed` (the real reason hidden in
//      `err.cause`: ECONNRESET, ConnectTimeoutError, getaddrinfo ENOTFOUND, …).
//      That transport failure used to escape the rate-limit retry loop and fail
//      the whole source after only fetchWithRetry's sub-2s retries. The fetcher
//      now retries transport errors, 5xx, rate-limits and transient non-JSON
//      within ONE generous budget, and reports the unwrapped cause so a failure
//      is diagnosable rather than a bare "fetch failed" (see makeGdeltFetcher).
//   4. GDELT's TLS handshake routinely runs 10–17s — past undici's DEFAULT 10s
//      connect timeout — so every attempt died at UND_ERR_CONNECT_TIMEOUT even
//      on a clean network. A dedicated undici Agent (gdeltAgent) raises the
//      connect timeout to 30s for GDELT requests only.

import { Agent } from 'undici';
import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchWithRetry, type FetchRetryOptions } from './contract';
import {
  GdeltTimelineResponseSchema,
  type GdeltTimelineResponse,
} from './gdelt.schema';

const SOURCE = 'gdelt';

const QUERY =
  '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng';

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

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
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Generous retry budget. This is a once-weekly job, so latency is irrelevant —
// trade it for reliability. Spacing between requests is owned by the shared
// pacer (createGdeltPacer), so retries need no backoff of their own: a retried
// request is paced ≥ GDELT_MIN_GAP_MS after the previous one, like any other.
const GDELT_TIMEOUT_MS = 60000; // per attempt; slow artlist/timeline windows
const GDELT_MAX_RETRIES = 5; // up to 6 attempts total
const GDELT_MIN_GAP_MS = 6000; // ≥ GDELT's documented 1-req/5s, with margin
const GDELT_CONNECT_TIMEOUT_MS = 30000; // GDELT's TLS handshake runs 10–17s

// `dispatcher` is a Node/undici extension to RequestInit, absent from lib.dom.
interface UndiciRequestInit extends RequestInit {
  dispatcher?: Agent;
}

// GDELT's TLS handshake routinely takes 10–17s — past undici's DEFAULT 10s
// connect timeout, which aborts mid-handshake as UND_ERR_CONNECT_TIMEOUT (and
// the AbortController timeout we set does NOT cover connection establishment).
// A dedicated Agent raises the connect/headers/body ceilings for GDELT only,
// so a slow-but-reachable GDELT succeeds instead of failing every paced retry.
// Scoped via `dispatcher` (not setGlobalDispatcher) so other collectors and the
// Worker are untouched; this module is imported only by the Node collector.
const gdeltAgent = new Agent({
  connect: { timeout: GDELT_CONNECT_TIMEOUT_MS },
  headersTimeout: GDELT_TIMEOUT_MS,
  bodyTimeout: GDELT_TIMEOUT_MS,
});

const gdeltRequestInit: UndiciRequestInit = {
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  dispatcher: gdeltAgent,
};

const isRateLimited = (status: number, body: string): boolean =>
  status === 429 || /limit requests|one every \d+ seconds/i.test(body);

/**
 * Render an error with its `cause` chain. Node's global fetch throws an opaque
 * `TypeError: fetch failed` and stashes the real transport error (ECONNRESET,
 * ConnectTimeoutError, getaddrinfo ENOTFOUND, …) in `err.cause`. Unwrapping it
 * turns "fetch failed" into something actionable in the logs and typed error.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    parts.push(
      typeof code === 'string' ? `${cur.message} (${code})` : cur.message
    );
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

export interface GdeltPacer {
  /** Resolves when it is safe to start the next GDELT request. */
  acquire(): Promise<void>;
}

/**
 * Process-wide GDELT request pacer. GDELT permits ≤1 request / 5s per IP,
 * counted across EVERY endpoint (the timeline modes AND the artlist news pool)
 * and every retry — not per collector. Independent per-collector spacing let
 * the artlist request, or a retry, land within 5s of a timeline request and
 * trip the "Please limit requests to one every 5 seconds" notice. This
 * serializes all GDELT requests through one gate and guarantees ≥ minGapMs
 * between successive request starts. (Weekly job — the added latency is moot.)
 */
export function createGdeltPacer(
  minGapMs = GDELT_MIN_GAP_MS,
  sleepImpl: (ms: number) => Promise<void> = sleep
): GdeltPacer {
  let tail: Promise<void> = Promise.resolve();
  let nextAllowedAt = 0;
  return {
    acquire(): Promise<void> {
      const mine = tail.then(async () => {
        const wait = nextAllowedAt - Date.now();
        if (wait > 0) await sleepImpl(wait);
        nextAllowedAt = Date.now() + minGapMs;
      });
      // Chain so the next acquire proceeds only after mine has claimed its
      // slot; swallow rejection so the gate can never deadlock (the body above
      // never rejects anyway).
      tail = mine.catch(() => undefined);
      return mine;
    },
  };
}

/** The single process-wide pacer shared by every production GDELT request. */
const sharedGdeltPacer = createGdeltPacer();

/** Low-level fetch seam so the retry loop is unit-testable without a network. */
export type ResponseFetcher = (
  url: string,
  opts: FetchRetryOptions
) => Promise<Response>;

export interface GdeltFetcherDeps {
  fetchImpl?: ResponseFetcher;
  /** Request pacer (≥5s between GDELT requests). Tests pass a no-op. */
  pacer?: GdeltPacer;
  maxRetries?: number;
}

/**
 * Build the rate-limit- AND transport-aware GDELT JSON fetcher. Every request
 * (initial or retry) passes through the shared {@link GdeltPacer}, so spacing
 * obeys GDELT's 1-req/5s limit across all endpoints and retries. A single loop
 * then rides out every *transient* failure within one generous budget:
 *   - transport ("fetch failed", abort/timeout, DNS, reset) → retry
 *   - HTTP 5xx                                              → retry
 *   - rate-limit (429 / "limit requests" text)             → retry
 *   - transient non-JSON / truncated body                  → retry
 * A 4xx (e.g. a malformed query) won't clear on retry, so it throws at once.
 * When the budget is exhausted it throws a typed {@link GdeltResponseError}
 * that reports the unwrapped cause. Deps are injectable so the retry behaviour
 * is exercised offline (see gdelt.test.ts) rather than against the live API.
 */
export function makeGdeltFetcher(deps: GdeltFetcherDeps = {}): JsonFetcher {
  const {
    fetchImpl = (url, opts) => fetchWithRetry(url, opts),
    pacer = sharedGdeltPacer,
    maxRetries = GDELT_MAX_RETRIES,
  } = deps;

  return async (url) => {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Pace EVERY request — initial AND retry — through the shared gate, so no
      // code path or retry can breach GDELT's 1-req/5s limit. This is also the
      // only spacing the retry loop needs: a retry is just the next paced
      // request, ≥5s after the previous one.
      await pacer.acquire();

      let res: Response;
      let body: string;
      try {
        res = await fetchImpl(url, {
          // Inner retries:0 — fetchWithRetry must make EXACTLY ONE request per
          // call so the outer paced loop owns ALL retries. Its own sub-2s
          // backoff would otherwise fire an un-paced request and breach GDELT's
          // 5s limit. With 0, every HTTP request is preceded by pacer.acquire().
          retries: 0,
          timeoutMs: GDELT_TIMEOUT_MS,
          init: gdeltRequestInit,
        });
        body = await res.text();
      } catch (err) {
        // Transport-level failure ("fetch failed", abort/timeout, DNS, reset).
        lastErr = err;
        console.warn(
          `gdelt: transport error (attempt ${attempt + 1}/${
            maxRetries + 1
          }): ${describeFetchError(err)}`
        );
        continue;
      }

      if (isRateLimited(res.status, body)) {
        lastErr = new GdeltResponseError(
          `rate-limited: ${body.slice(0, 200).trim()}`
        );
        continue;
      }

      if (!res.ok) {
        if (res.status >= 500) {
          // Server-side wobble — worth the generous retry.
          lastErr = new GdeltResponseError(
            `HTTP ${res.status}: ${body.slice(0, 200).trim()}`
          );
          continue;
        }
        // 4xx (bad query, etc.) won't clear on retry — fail fast.
        throw new GdeltResponseError(
          `GDELT HTTP ${res.status} for ${url}: ${body.slice(0, 200).trim()}`
        );
      }

      const contentType = res.headers.get('content-type') ?? '';
      const looksJson = contentType.includes('json') || /^\s*[[{]/.test(body);
      if (!looksJson) {
        // Often a transient CDN/error HTML page during a GDELT wobble — retry.
        lastErr = new GdeltResponseError(
          `non-JSON (content-type "${contentType}"): ${body.slice(0, 200).trim()}`
        );
        continue;
      }

      try {
        return JSON.parse(body) as unknown;
      } catch {
        // Truncated/garbled body — retry within budget.
        lastErr = new GdeltResponseError(
          `malformed JSON: ${body.slice(0, 200).trim()}`
        );
        continue;
      }
    }

    throw new GdeltResponseError(
      `GDELT failed after ${
        maxRetries + 1
      } attempts for ${url}: ${describeFetchError(lastErr)}`
    );
  };
}

export const defaultFetcher: JsonFetcher = makeGdeltFetcher();

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

async function collect(fetcher: JsonFetcher): Promise<CollectorResult> {
  // Recurring path: recent edge only, 2 requests, STRICT (a bad/rate-limited
  // response throws → runner marks the source failed, failure-isolated).
  // Request spacing (GDELT's 1-req/5s limit) is owned by the fetcher's pacer,
  // not here, so these two timeline modes, the artlist news request and every
  // retry share one global gate. Recurring weekly job: only the recent edge —
  // history is immutable and already stored; the one-time backfill
  // (collectGdeltHistory) handles 2022→.
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
 * throws only if EVERY window of EVERY mode failed. The fetcher's pacer keeps
 * every window request ≥5s apart (latency is irrelevant — run once, manually).
 * The recurring weekly `collect` deliberately does NOT do this.
 */
export async function collectGdeltHistory(
  fetcher: JsonFetcher = defaultFetcher
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
    return collect(defaultFetcher);
  },
  runWith(fetcher: JsonFetcher): Promise<CollectorResult> {
    // Tests inject a synchronous fetcher; the pacer is bypassed (no network).
    return collect(fetcher);
  },
};
