// Shared collector runtime: HTTP retry/backoff and a runner that persists
// results. Every collector in this directory is a `Collector` (see types.ts);
// the runner — not the collector — touches the DB, so each source stays
// independently unit-testable with a mocked fetch.

import type { Collector, Env } from '../types';
import { insertSnapshots, upsertMarkets } from '../db';

export interface FetchRetryOptions {
  retries?: number;
  /** Base delay in ms; grows exponentially with full jitter. */
  baseDelayMs?: number;
  timeoutMs?: number;
  init?: RequestInit;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * fetch() with exponential backoff + jitter. Retries network errors and 5xx /
 * 429 responses; returns 4xx (other than 429) immediately since retrying a bad
 * request never helps. Throws after exhausting retries.
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { retries = 3, baseDelayMs = 500, timeoutMs = 15000, init } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === retries) break;
    }
    const backoff = baseDelayMs * 2 ** attempt;
    await sleep(Math.random() * backoff);
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fetchWithRetry failed for ${url}`);
}

/** Fetch JSON with retry. Caller is responsible for Zod-parsing the result. */
export async function fetchJson(
  url: string,
  opts: FetchRetryOptions = {}
): Promise<unknown> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export interface CollectorRunSummary {
  source: string;
  ok: boolean;
  snapshotsAdded: number;
  marketsUpserted: number;
  error?: string;
}

/**
 * Run one collector and persist its result. Failure is isolated: a thrown
 * error is captured in the summary so one bad source degrades one widget,
 * not the whole cron run.
 */
export async function runCollector(
  env: Env,
  collector: Collector
): Promise<CollectorRunSummary> {
  try {
    const result = await collector.run(env);
    const snapshotsAdded = await insertSnapshots(env, result.snapshots);
    if (result.markets?.length) await upsertMarkets(env, result.markets);
    return {
      source: collector.name,
      ok: true,
      snapshotsAdded,
      marketsUpserted: result.markets?.length ?? 0,
    };
  } catch (err) {
    return {
      source: collector.name,
      ok: false,
      snapshotsAdded: 0,
      marketsUpserted: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run many collectors concurrently; never throws (per-source isolation). */
export async function runCollectors(
  env: Env,
  collectors: Collector[]
): Promise<CollectorRunSummary[]> {
  return Promise.all(collectors.map((c) => runCollector(env, c)));
}
