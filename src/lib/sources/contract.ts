// Shared collector runtime: HTTP retry/backoff and a failure-isolated runner.
// The runner does NOT persist — it returns each collector's CollectorResult so
// the caller (the collect script) writes to the repo data files. Collectors
// stay pure and independently unit-testable with a mocked fetch.

import type { Collector, CollectorResult, Env } from '../types';

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

export interface CollectorRunResult {
  source: string;
  ok: boolean;
  result?: CollectorResult;
  error?: string;
}

/**
 * Run one collector. Failure is isolated: a thrown error is captured so one
 * bad source degrades one widget, not the whole run. Does not persist.
 */
export async function runCollector(
  collector: Collector,
  env: Env
): Promise<CollectorRunResult> {
  try {
    const result = await collector.run(env);
    return { source: collector.name, ok: true, result };
  } catch (err) {
    return {
      source: collector.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run many collectors concurrently; never throws (per-source isolation). */
export async function runCollectors(
  collectors: Collector[],
  env: Env
): Promise<CollectorRunResult[]> {
  return Promise.all(collectors.map((c) => runCollector(c, env)));
}
