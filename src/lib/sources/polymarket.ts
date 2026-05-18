// Polymarket collector — primary Russia–Ukraine war-end forecast signal.
//
// Real endpoint (public, no auth, no key required):
//   GET https://gamma-api.polymarket.com/markets
//       ?closed=false
//       &limit=100
//       &order=volume
//       &ascending=false
//       &tag=ukraine
//
//   The Gamma API returns a JSON array of market objects. We filter that array
//   to markets whose question is about the war ending / a ceasefire / a peace
//   deal (see WAR_END_PATTERN). For each matching binary market the "Yes"
//   outcome price (outcomePrices[0]) is already a 0–1 probability of the war
//   ending by that market's resolution date.
//
//   Polymarket also exposes a price-history Data API at
//   https://clob.polymarket.com/prices-history?market=<tokenId>&interval=max
//   for time-series; Phase 1 only needs the current cross-market probability,
//   so we keep this collector to the Gamma snapshot and emit per-market rows
//   for the HeroChart's market list. History ingestion is a later phase.
//
// Output:
//   - snapshots: one aggregate `war_end_probability` (liquidity-weighted mean
//     of qualifying markets) plus one `war_end_probability` per market keyed by
//     a metric suffix is intentionally avoided — the runner persists with
//     UNIQUE(metric, source, ts), so we emit a single aggregate snapshot and
//     keep per-market detail in MarketRow[].
//   - markets: one MarketRow per qualifying war-end market.
//
// The HTTP layer is injectable (defaults to the real fetchJson) so unit tests
// run fully offline with a mocked payload.

import type { Collector, CollectorResult, Env, MarketRow, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  PolymarketMarketsResponseSchema,
  decodeJsonStringArray,
  type PolymarketMarket,
} from './polymarket.schema';

export const POLYMARKET_SOURCE = 'polymarket';
export const WAR_END_METRIC = 'war_end_probability';

const GAMMA_MARKETS_URL =
  'https://gamma-api.polymarket.com/markets?closed=false&limit=100&order=volume&ascending=false&tag=ukraine';

/**
 * Heuristic match for "does the Russia–Ukraine war end / ceasefire / peace
 * deal" markets. Kept broad on intent words, then required to mention the
 * conflict so unrelated markets don't leak in.
 */
const WAR_END_PATTERN =
  /\b(war end|end of the war|ceasefire|cease-fire|peace deal|peace agreement|armistice|end the war|war.*ends?)\b/i;
const CONFLICT_PATTERN = /\b(ukrain\w*|russia\w*|russo-ukrainian)\b/i;

/** Injectable HTTP layer so tests can supply a mock payload. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

function isWarEndMarket(question: string): boolean {
  return WAR_END_PATTERN.test(question) && CONFLICT_PATTERN.test(question);
}

/**
 * Best-effort ISO-8601 UTC normalisation. Polymarket timestamps are already
 * ISO strings; we re-serialise through Date to guarantee a valid UTC `Z`
 * string and reject garbage. Returns undefined when unparseable.
 */
function toIsoUtc(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/** "Yes" probability for a binary market, clamped to [0, 1]. */
function yesProbability(m: PolymarketMarket): number | null {
  const prices = decodeJsonStringArray(m.outcomePrices)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  let p: number | null = null;
  if (prices.length > 0) {
    p = prices[0];
  } else if (typeof m.lastTradePrice === 'number') {
    p = m.lastTradePrice;
  } else if (typeof m.bestBid === 'number' && typeof m.bestAsk === 'number') {
    p = (m.bestBid + m.bestAsk) / 2;
  }
  if (p === null || !Number.isFinite(p)) return null;
  return Math.min(1, Math.max(0, p));
}

function liquidityUsd(m: PolymarketMarket): number | null {
  const l = m.liquidityNum ?? m.liquidity;
  return typeof l === 'number' && Number.isFinite(l) ? l : null;
}

/**
 * Parse a raw Polymarket response and map it to snapshots + markets.
 * Exported so tests can exercise the pure mapping without the fetch layer.
 */
export function mapPolymarketResponse(raw: unknown, nowIso: string): CollectorResult {
  const markets = PolymarketMarketsResponseSchema.parse(raw);

  const rows: MarketRow[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let plainSum = 0;
  let plainCount = 0;

  for (const m of markets) {
    if (m.closed === true) continue;
    if (!isWarEndMarket(m.question)) continue;

    const prob = yesProbability(m);
    const resolution =
      toIsoUtc(m.endDate) ?? toIsoUtc(m.closedTime) ?? nowIso;
    const liq = liquidityUsd(m);

    rows.push({
      market_id: `polymarket:${m.id}`,
      source: POLYMARKET_SOURCE,
      question: m.question,
      resolution_date: resolution,
      category: 'war_end',
      current_price: prob,
      liquidity_usd: liq,
      last_updated: nowIso,
    });

    if (prob !== null) {
      plainSum += prob;
      plainCount += 1;
      // Weight by liquidity when available; deeper markets are more reliable.
      const w = liq && liq > 0 ? liq : 1;
      weightedSum += prob * w;
      weightTotal += w;
    }
  }

  const snapshots: SnapshotInput[] = [];
  if (plainCount > 0) {
    const aggregate = weightTotal > 0 ? weightedSum / weightTotal : plainSum / plainCount;
    snapshots.push({
      metric: WAR_END_METRIC,
      source: POLYMARKET_SOURCE,
      ts: nowIso,
      value: Math.min(1, Math.max(0, aggregate)),
      // Confidence rises with the number of qualifying markets, capped at 1.
      confidence: Math.min(1, plainCount / 3),
      raw_blob: JSON.stringify({
        markets: plainCount,
        liquidityWeighted: weightTotal > 0,
      }),
    });
  }

  return { snapshots, markets: rows };
}

/**
 * Build a Polymarket collector. The fetcher is injectable purely for testing;
 * production code uses the real retrying fetchJson by default.
 */
export function createPolymarketCollector(fetcher: JsonFetcher = defaultFetcher): Collector {
  return {
    name: POLYMARKET_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const raw = await fetcher(GAMMA_MARKETS_URL);
      const nowIso = new Date().toISOString();
      return mapPolymarketResponse(raw, nowIso);
    },
  };
}

export const polymarketCollector: Collector = createPolymarketCollector();
