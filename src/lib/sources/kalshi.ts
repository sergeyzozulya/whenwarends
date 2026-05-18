// Kalshi collector — secondary forecast signal for the Russia–Ukraine war end.
//
// Real endpoint (PUBLIC, NO auth required) — LIVE-VERIFIED 2026-05-18:
//   GET https://external-api.kalshi.com/trade-api/v2/markets
//       ?series_ticker=<series>&status=open&limit=100&cursor=<cursor>
//
// Why the old code 403'd: it used `api.elections.kalshi.com`, which is the
// AUTHENTICATED production host — unauthenticated requests there return 403.
// The public market-data host is `external-api.kalshi.com`. We also send a
// realistic User-Agent + Accept header (Kalshi web/edge rejects some default
// fetch UAs; the API tolerates the default but the explicit UA is safer and
// is good citizenship for a public free API).
//
// Notes on the (restructured) real API:
//   - Prices are fixed-point DOLLAR STRINGS in [0,1] (e.g. "0.1700") — already
//     the implied YES probability. No cents→fraction division anymore. The
//     Zod schema coerces the string and enforces the [0,1] invariant.
//   - `volume_fp` is a fixed-point count string; `liquidity_dollars` is
//     deprecated and returns "0.0000", so volume is the liquidity proxy.
//   - Timestamps (`close_time`, `expiration_time`, `latest_expiration_time`)
//     are ISO-8601 UTC; we re-emit through `new Date(...).toISOString()` so the
//     stored value is canonical UTC ISO-8601 regardless of upstream formatting.
//   - Status enum: only "active" markets carry a live tradable quote.
//   - Pagination is cursor-based; `cursor === ''` means no further pages. We
//     follow the cursor so a multi-page series is fully ingested.
//
// CONTRACT FRICTION (reported, not worked around): as of 2026-05-18 there is
// NO Kalshi series for "when does the Russia–Ukraine war end" in the live
// public feed (open OR settled) — `KXRUSUKRWAR` and ceasefire-named series
// return zero markets; the ceasefire ladder appears to have settled and aged
// out after the May 2026 US-brokered ceasefire. The closest live, structurally
// equivalent war-relevant ladder is `KXZELENSKYYOUT` (dated Yes/No ladder with
// real two-sided quotes), used as the default series so this collector emits a
// real signal today. The series is overridable via the
// `KALSHI_SERIES_TICKER` env var (not in the frozen `Env`; read defensively
// from process.env) so the editor can repoint it the moment Kalshi relists a
// canonical war-end market — no code change or redeploy of this file needed.
//
// Mapping:
//   - SnapshotInput: metric 'war_end_probability', source 'kalshi',
//     value = mid-price in 0–1, confidence derived from quote spread.
//   - MarketRow: one row per active market, current_price in 0–1.

import { fetchJson } from './contract';
import {
  KalshiMarketsResponseSchema,
  type KalshiMarket,
} from './kalshi.schema';
import type {
  Collector,
  CollectorResult,
  Env,
  MarketRow,
  SnapshotInput,
} from '../types';

/** Public, unauthenticated market-data host (NOT api.elections.kalshi.com). */
const KALSHI_API_BASE = 'https://external-api.kalshi.com/trade-api/v2';

/**
 * Default series ticker. There is currently no canonical Kalshi war-end
 * series (see file header). `KXZELENSKYYOUT` is the closest live, structurally
 * equivalent war-relevant ladder. Overridable via KALSHI_SERIES_TICKER.
 */
const DEFAULT_SERIES_TICKER = 'KXZELENSKYYOUT';

/** Realistic UA + JSON Accept for a public free API. */
const KALSHI_HEADERS: Record<string, string> = {
  'User-Agent':
    'whenwarends/1.0 (+https://whenwarends.org; non-commercial; contact: editor)',
  Accept: 'application/json',
};

export const SOURCE = 'kalshi' as const;
export const METRIC_WAR_END_PROBABILITY = 'war_end_probability' as const;

/** Injectable fetcher so unit tests can supply a mocked Kalshi payload. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) =>
  fetchJson(url, { init: { headers: KALSHI_HEADERS } });

/** Resolve the series ticker from env (not in frozen Env) or fall back. */
function resolveSeriesTicker(): string {
  // process.env is supplied by the collect script; read defensively. Not in
  // the frozen Env interface, so access via a typed shim without `any`.
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const t = env.KALSHI_SERIES_TICKER;
  return t && t.trim() !== '' ? t.trim() : DEFAULT_SERIES_TICKER;
}

function marketsUrl(seriesTicker: string, cursor?: string): string {
  const params = new URLSearchParams({
    series_ticker: seriesTicker,
    status: 'open',
    limit: '100',
  });
  if (cursor) params.set('cursor', cursor);
  return `${KALSHI_API_BASE}/markets?${params.toString()}`;
}

/**
 * Best available implied probability for a market. Prices are already 0–1
 * (dollar strings coerced by the schema):
 *   - prefer the bid/ask mid when both quotes exist,
 *   - else fall back to last traded price,
 *   - else a single available quote.
 * Returns null when no price signal is present at all.
 */
function impliedProbability(m: KalshiMarket): number | null {
  const bid = m.yes_bid_dollars;
  const ask = m.yes_ask_dollars;
  const last = m.last_price_dollars;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  if (last !== undefined) return last;
  if (ask !== undefined) return ask;
  if (bid !== undefined) return bid;
  return null;
}

/**
 * Confidence 0–1 from quote tightness: a tight bid/ask spread is a
 * higher-confidence signal than a wide one. No two-sided quote → low
 * confidence (0.3) but still usable as a secondary signal. Spread is now in
 * dollars (0..1) since prices are 0–1.
 */
function confidenceFromSpread(m: KalshiMarket): number {
  const bid = m.yes_bid_dollars;
  const ask = m.yes_ask_dollars;
  if (bid === undefined || ask === undefined) return 0.3;
  const spread = Math.abs(ask - bid); // dollars, 0..1
  const c = 1 - spread;
  // Clamp defensively against crossed quotes.
  return Math.min(1, Math.max(0, c));
}

/** Normalise any ISO-8601 input to canonical UTC ISO-8601, or null. */
function toIsoUtc(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function questionOf(m: KalshiMarket): string {
  if (m.title && m.yes_sub_title) return `${m.title} — ${m.yes_sub_title}`;
  if (m.title && m.subtitle) return `${m.title} — ${m.subtitle}`;
  return m.title ?? m.yes_sub_title ?? m.ticker;
}

function toMarketRow(m: KalshiMarket, observedAt: string): MarketRow {
  const resolution =
    toIsoUtc(m.expiration_time) ??
    toIsoUtc(m.latest_expiration_time) ??
    toIsoUtc(m.close_time) ??
    observedAt;
  // liquidity_dollars is deprecated ("0.0000"); volume_fp is the real proxy.
  const liquidityUsd =
    m.volume_fp !== undefined
      ? m.volume_fp
      : m.liquidity_dollars !== undefined
        ? m.liquidity_dollars
        : null;
  return {
    market_id: m.ticker,
    source: SOURCE,
    question: questionOf(m),
    resolution_date: resolution,
    category: 'war_end',
    current_price: impliedProbability(m),
    liquidity_usd: liquidityUsd,
    last_updated: observedAt,
  };
}

function toSnapshot(m: KalshiMarket, observedAt: string): SnapshotInput | null {
  const value = impliedProbability(m);
  if (value === null) return null;
  return {
    metric: METRIC_WAR_END_PROBABILITY,
    source: SOURCE,
    ts: observedAt,
    value,
    raw_blob: JSON.stringify(m),
    confidence: confidenceFromSpread(m),
  };
}

/**
 * Pull Kalshi public market data, following cursor pagination, Zod-parse at
 * the boundary, and map to snapshots + market rows. `fetcher` is injectable
 * for mock-based tests.
 */
export async function collectKalshi(
  fetcher: JsonFetcher = defaultFetcher
): Promise<CollectorResult> {
  const seriesTicker = resolveSeriesTicker();
  const observedAt = new Date().toISOString();

  const all: KalshiMarket[] = [];
  let cursor: string | undefined;
  // Bounded loop: a war-end ladder is small; cap pages defensively so a
  // misbehaving cursor can never spin forever.
  for (let page = 0; page < 20; page++) {
    const raw = await fetcher(marketsUrl(seriesTicker, cursor));
    // Parse at the boundary: downstream code works only with typed objects.
    const parsed = KalshiMarketsResponseSchema.parse(raw);
    all.push(...parsed.markets);
    const next = parsed.cursor;
    if (!next || next === '') break;
    cursor = next;
  }

  // Only "active" markets carry a live, tradable price signal.
  const live = all.filter((m) => m.status.toLowerCase() === 'active');

  const snapshots: SnapshotInput[] = [];
  const markets: MarketRow[] = [];
  for (const m of live) {
    const snap = toSnapshot(m, observedAt);
    if (snap) snapshots.push(snap);
    markets.push(toMarketRow(m, observedAt));
  }

  return { snapshots, markets };
}

export const kalshiCollector: Collector = {
  name: SOURCE,
  async run(_env: Env): Promise<CollectorResult> {
    return collectKalshi();
  },
};
