// Kalshi collector — secondary forecast signal for the Russia–Ukraine war end.
//
// Real endpoint (public, no auth required):
//   GET https://api.elections.kalshi.com/trade-api/v2/markets
//       ?series_ticker=KXRUSUKRWAR&status=open&limit=100
//
// Notes on the real API:
//   - The /markets feed is open and unauthenticated for public market data.
//   - Prices are integer cents (0–100) representing the implied probability
//     of the YES outcome; we normalise to a 0–1 float here.
//   - Timestamps (`close_time`, `expiration_time`) are ISO-8601 UTC; we
//     re-emit them through `new Date(...).toISOString()` so the stored value
//     is canonical UTC ISO-8601 regardless of the upstream formatting.
//   - The exact `series_ticker` for the war-end market is set via
//     KALSHI_SERIES_TICKER below; it is documented here so the live query is
//     reproducible. Correctness is proven entirely by mocked tests — this
//     collector has no live dependency in CI.
//
// Mapping:
//   - SnapshotInput: metric 'war_end_probability', source 'kalshi',
//     value = mid-price in 0–1, confidence derived from quote spread.
//   - MarketRow: one row per open market, current_price in 0–1.

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

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

/** Series ticker for the Russia–Ukraine war-end market family. */
const KALSHI_SERIES_TICKER = 'KXRUSUKRWAR';

const KALSHI_MARKETS_URL =
  `${KALSHI_API_BASE}/markets` +
  `?series_ticker=${KALSHI_SERIES_TICKER}&status=open&limit=100`;

export const SOURCE = 'kalshi' as const;
export const METRIC_WAR_END_PROBABILITY = 'war_end_probability' as const;

/** Injectable fetcher so unit tests can supply a mocked Kalshi payload. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

/** Integer cents (0–100) → 0–1 float probability. */
function centsToProbability(cents: number): number {
  return cents / 100;
}

/**
 * Best available implied probability for a market:
 *   - prefer the bid/ask mid when both quotes exist,
 *   - else fall back to last traded price,
 *   - else a single available quote.
 * Returns null when no price signal is present at all.
 */
function impliedProbability(m: KalshiMarket): number | null {
  const { yes_bid, yes_ask, last_price } = m;
  if (yes_bid !== undefined && yes_ask !== undefined) {
    return centsToProbability((yes_bid + yes_ask) / 2);
  }
  if (last_price !== undefined) return centsToProbability(last_price);
  if (yes_ask !== undefined) return centsToProbability(yes_ask);
  if (yes_bid !== undefined) return centsToProbability(yes_bid);
  return null;
}

/**
 * Confidence 0–1 from quote tightness: a tight bid/ask spread is a
 * higher-confidence signal than a wide one. No two-sided quote → low
 * confidence (0.3) but still usable as a secondary signal.
 */
function confidenceFromSpread(m: KalshiMarket): number {
  const { yes_bid, yes_ask } = m;
  if (yes_bid === undefined || yes_ask === undefined) return 0.3;
  const spread = Math.abs(yes_ask - yes_bid); // cents, 0..100
  const c = 1 - spread / 100;
  // Clamp into [0, 1] defensively against crossed quotes.
  return Math.min(1, Math.max(0, c));
}

/** Normalise any ISO-8601 input to canonical UTC ISO-8601, or null. */
function toIsoUtc(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toMarketRow(m: KalshiMarket, observedAt: string): MarketRow {
  const resolution =
    toIsoUtc(m.expiration_time) ?? toIsoUtc(m.close_time) ?? observedAt;
  const liquidityUsd =
    m.liquidity !== undefined
      ? m.liquidity
      : m.volume !== undefined
        ? m.volume
        : null;
  return {
    market_id: m.ticker,
    source: SOURCE,
    question: m.subtitle ? `${m.title} — ${m.subtitle}` : m.title,
    resolution_date: resolution,
    category: m.category ?? 'war_end',
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
 * Pull Kalshi public market data, Zod-parse at the boundary, and map to
 * snapshots + market rows. `fetcher` is injectable for mock-based tests.
 */
export async function collectKalshi(
  fetcher: JsonFetcher = defaultFetcher
): Promise<CollectorResult> {
  const raw = await fetcher(KALSHI_MARKETS_URL);
  // Parse at the boundary: downstream code works only with typed objects.
  const parsed = KalshiMarketsResponseSchema.parse(raw);
  const observedAt = new Date().toISOString();

  // Only "active"/"open" markets carry a live, tradable price signal.
  const live = parsed.markets.filter((m) => {
    const s = m.status.toLowerCase();
    return s === 'active' || s === 'open';
  });

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
