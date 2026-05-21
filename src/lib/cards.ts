// Market selections, cross-source weighting, consensus, and the derived
// snapshots that give the hero its history (SPEC §8). Used in two places that
// must agree exactly: the page (build-time render) and the collect script
// (which appends one snapshot per market per run, plus the consensus, since
// markets.json is current-only and holds no trajectory).
// Pure and deterministic; unit-tested in tests/unit/cards.test.ts.

import type { MarketRow, SnapshotInput } from './types';
import type { CDFPoint } from './cdf';
import { isWarEndMarket } from './sources/warEndFilter';

/** Source tag for the derived (computed, not external) snapshots. */
export const CARD_SOURCE = 'derived';
/** Per-market price history (one row per market per run); source = market_id. */
export const MARKET_PRICE_METRIC = 'market_price';
/** Tracked consensus centroid: probability (0–1) and resolution date (epoch ms). */
export const CONSENSUS_PROB_METRIC = 'war_end_consensus_probability';
export const CONSENSUS_DATE_METRIC = 'war_end_consensus_date';

/** Per-source quality floors (SPEC §8.1). Manifold mana floor is tunable. */
export const POLY_FLOOR_USD = 10_000;
export const MANI_FLOOR_MANA = 1000;
/** A war-end market resolving beyond this many months is not a timing market. */
export const MAX_HORIZON_MONTHS = 36;

function horizonMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() + MAX_HORIZON_MONTHS);
  return d.getTime();
}

export type LiquidityUnit = 'usd' | 'mana';

export interface CardPick {
  marketId: string;
  price: number; // 0–1
  dateMs: number;
  dateIso: string;
  source: string; // platform
  question: string;
  liquidity: number | null;
  liquidityUnit: LiquidityUnit;
}

export interface CardPicks {
  closest: CardPick | null;
  optimistic: CardPick | null;
}

export interface ConsensusPoint {
  probability: number; // 0–1
  dateMs: number;
  dateIso: string;
}

/** A market's liquidity figure with its unit (USD for Polymarket, mana else). */
export function marketLiquidity(m: MarketRow): {
  value: number | null;
  unit: LiquidityUnit;
} {
  if (m.liquidity_usd != null) return { value: m.liquidity_usd, unit: 'usd' };
  if (m.liquidity_mana != null) return { value: m.liquidity_mana, unit: 'mana' };
  return { value: null, unit: 'usd' };
}

/**
 * Priced, war-end markets that clear their source's quality floor and resolve
 * within the horizon (§8.1). A market resolving decades out is not a war-end
 * timing market regardless of phrasing.
 */
export function qualifyMarkets(
  markets: MarketRow[],
  nowMs: number = Date.now()
): MarketRow[] {
  const maxMs = horizonMs(nowMs);
  return markets.filter((m) => {
    if (m.current_price === null) return false;
    // Re-validate the question so stale markets.json rows from an older,
    // looser filter can't linger on the chart.
    if (!isWarEndMarket(m.question)) return false;
    const t = Date.parse(m.resolution_date);
    if (!Number.isFinite(t) || t > maxMs) return false;
    if (m.liquidity_usd != null) return m.liquidity_usd >= POLY_FLOOR_USD;
    if (m.liquidity_mana != null) return m.liquidity_mana >= MANI_FLOOR_MANA;
    return false; // no liquidity figure ⇒ drop
  });
}

/**
 * Normalized cross-source weights (§8.3): within each source weight by its own
 * liquidity; give each present source an equal share. Σ weights = 1 over the
 * qualified set. Input must already be qualified.
 */
export function marketWeights(qualified: MarketRow[]): Map<string, number> {
  const bySource = new Map<string, MarketRow[]>();
  for (const m of qualified) {
    const arr = bySource.get(m.source) ?? [];
    arr.push(m);
    bySource.set(m.source, arr);
  }
  const sourceShare = bySource.size > 0 ? 1 / bySource.size : 0;
  const weights = new Map<string, number>();
  for (const arr of bySource.values()) {
    const liqs = arr.map((m) => {
      const l = marketLiquidity(m).value;
      return l != null && l > 0 ? l : 0;
    });
    const total = liqs.reduce((s, x) => s + x, 0);
    arr.forEach((m, i) => {
      const within = total > 0 ? liqs[i] / total : 1 / arr.length;
      weights.set(m.market_id, sourceShare * within);
    });
  }
  return weights;
}

/**
 * Qualified markets → CDFPoint[] where `liquidity` carries the normalized
 * cross-source weight. Call computeCDF with liquidityFloorUsd: 0 — quality is
 * already filtered upstream (qualifyMarkets), and the curve weights by `weight`.
 */
export function marketsToCdfPoints(markets: MarketRow[]): CDFPoint[] {
  const qualified = qualifyMarkets(markets);
  const weights = marketWeights(qualified);
  return qualified.map((m) => ({
    date: m.resolution_date,
    probability: m.current_price as number,
    liquidity: weights.get(m.market_id) ?? 0,
  }));
}

function toPick(m: MarketRow): CardPick {
  const liq = marketLiquidity(m);
  return {
    marketId: m.market_id,
    price: m.current_price as number,
    dateMs: Date.parse(m.resolution_date),
    dateIso: m.resolution_date,
    source: m.source,
    question: m.question,
    liquidity: liq.value,
    liquidityUnit: liq.unit,
  };
}

/**
 * The two stat-card selections (§8.5):
 *  - closest: resolution date nearest today (nearest future; else nearest
 *    overall); ties → higher probability.
 *  - optimistic: highest probability; ties → nearest to today.
 */
export function deriveSelections(markets: MarketRow[], nowMs: number): CardPicks {
  const q = qualifyMarkets(markets, nowMs);
  if (q.length === 0) return { closest: null, optimistic: null };

  const dist = (m: MarketRow) => Math.abs(Date.parse(m.resolution_date) - nowMs);
  const future = q.filter((m) => Date.parse(m.resolution_date) >= nowMs);
  const closestPool = future.length > 0 ? future : q;

  let closest: MarketRow | null = null;
  for (const m of closestPool) {
    if (
      closest === null ||
      dist(m) < dist(closest) ||
      (dist(m) === dist(closest) &&
        (m.current_price as number) > (closest.current_price as number))
    ) {
      closest = m;
    }
  }

  let optimistic: MarketRow | null = null;
  for (const m of q) {
    if (
      optimistic === null ||
      (m.current_price as number) > (optimistic.current_price as number) ||
      ((m.current_price as number) === (optimistic.current_price as number) &&
        dist(m) < dist(optimistic))
    ) {
      optimistic = m;
    }
  }

  return {
    closest: closest ? toPick(closest) : null,
    optimistic: optimistic ? toPick(optimistic) : null,
  };
}

/**
 * Consensus = liquidity-weighted centroid of all qualified markets (§8.5):
 * date = Σ wᵢ·dateᵢ, probability = Σ wᵢ·pᵢ (Σ w = 1). Both move over time.
 */
export function deriveConsensus(markets: MarketRow[]): ConsensusPoint | null {
  const q = qualifyMarkets(markets);
  if (q.length === 0) return null;
  const weights = marketWeights(q);
  let dSum = 0;
  let pSum = 0;
  for (const m of q) {
    const w = weights.get(m.market_id) ?? 0;
    dSum += w * Date.parse(m.resolution_date);
    pSum += w * (m.current_price as number);
  }
  const dateMs = Math.round(dSum);
  if (!Number.isFinite(dateMs) || !Number.isFinite(pSum)) return null;
  return {
    probability: Math.min(1, Math.max(0, pSum)),
    dateMs,
    dateIso: new Date(dateMs).toISOString(),
  };
}

/** One immutable price snapshot per qualified market (the per-market history). */
export function marketHistorySnapshots(
  markets: MarketRow[],
  tsIso: string
): SnapshotInput[] {
  return qualifyMarkets(markets).map((m) => {
    const liq = marketLiquidity(m);
    return {
      metric: MARKET_PRICE_METRIC,
      source: m.market_id, // overloaded to the market id ⇒ unique per market
      ts: tsIso,
      value: m.current_price as number,
      raw_blob: JSON.stringify({
        platform: m.source,
        question: m.question,
        resolution_date: m.resolution_date,
        liquidity: liq.value,
        liquidity_unit: liq.unit,
      }),
      confidence: null,
    };
  });
}

/** Track the moving consensus centroid: probability + date, one row each. */
export function consensusSnapshots(
  markets: MarketRow[],
  tsIso: string
): SnapshotInput[] {
  const c = deriveConsensus(markets);
  if (!c) return [];
  return [
    {
      metric: CONSENSUS_PROB_METRIC,
      source: CARD_SOURCE,
      ts: tsIso,
      value: c.probability,
      raw_blob: JSON.stringify({ consensus_date: c.dateIso }),
      confidence: null,
    },
    {
      metric: CONSENSUS_DATE_METRIC,
      source: CARD_SOURCE,
      ts: tsIso,
      value: c.dateMs,
      raw_blob: null,
      confidence: null,
    },
  ];
}

/** All derived snapshots for one collect run: per-market history + consensus. */
export function allDerivedSnapshots(
  markets: MarketRow[],
  tsIso: string
): SnapshotInput[] {
  return [
    ...marketHistorySnapshots(markets, tsIso),
    ...consensusSnapshots(markets, tsIso),
  ];
}
