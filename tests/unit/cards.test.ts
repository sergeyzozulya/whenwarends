import { describe, it, expect } from 'vitest';
import {
  qualifyMarkets,
  marketWeights,
  deriveSelections,
  deriveConsensus,
  marketHistorySnapshots,
  consensusSnapshots,
  allDerivedSnapshots,
  CARD_SOURCE,
  MARKET_PRICE_METRIC,
  CONSENSUS_PROB_METRIC,
  CONSENSUS_DATE_METRIC,
  POLY_FLOOR_USD,
  MANI_FLOOR_MANA,
} from '../../src/lib/cards';
import type { MarketRow } from '../../src/lib/types';

interface MkOpts {
  source?: string;
  usd?: number | null;
  mana?: number | null;
}
const mk = (
  id: string,
  date: string,
  price: number | null,
  opts: MkOpts = {}
): MarketRow => ({
  market_id: id,
  source: opts.source ?? 'polymarket',
  // Must pass the shared war-end filter (qualifyMarkets re-validates the text).
  question: `Russia x Ukraine ceasefire — ${id}`,
  resolution_date: `${date}T00:00:00.000Z`,
  category: 'war_end',
  current_price: price,
  liquidity_usd: opts.usd === undefined ? 50_000 : opts.usd,
  liquidity_mana: opts.mana ?? null,
  last_updated: '2026-05-20T00:00:00.000Z',
});
const mani = (id: string, date: string, price: number, mana: number) =>
  mk(`manifold:${id}`, date, price, { source: 'manifold', usd: null, mana });

const NOW = Date.parse('2026-06-01T00:00:00Z');

describe('qualifyMarkets', () => {
  it('drops unpriced, below-floor, far-future, and off-topic markets', () => {
    const markets = [
      mk('null', '2026-07-01', null),
      mk('poorPoly', '2026-07-01', 0.5, { usd: POLY_FLOOR_USD / 2 }),
      mk('goodPoly', '2026-07-01', 0.5, { usd: POLY_FLOOR_USD * 2 }),
      mk('farFuture', '2040-01-01', 0.5, { usd: POLY_FLOOR_USD * 2 }), // beyond horizon
      mani('poor', '2026-07-01', 0.5, MANI_FLOOR_MANA / 2),
      mani('good', '2026-07-01', 0.5, MANI_FLOOR_MANA * 2),
      {
        ...mk('offtopic', '2026-07-01', 0.5, { usd: POLY_FLOOR_USD * 2 }),
        question: 'Will Bitcoin hit $100k in 2026?', // fails the war-end filter
      },
    ];
    const ids = qualifyMarkets(markets, NOW).map((m) => m.market_id).sort();
    expect(ids).toEqual(['goodPoly', 'manifold:good']);
  });
});

describe('marketWeights', () => {
  it('normalizes per source and combines them 50/50 (Σ = 1)', () => {
    const markets = [
      mk('p1', '2026-07-01', 0.4, { usd: 10_000 }),
      mk('p2', '2026-07-01', 0.4, { usd: 30_000 }),
      mani('m1', '2026-07-01', 0.4, 1_000),
    ];
    const w = marketWeights(qualifyMarkets(markets));
    expect(w.get('p1')).toBeCloseTo(0.125, 6); // 10k/40k * 0.5
    expect(w.get('p2')).toBeCloseTo(0.375, 6); // 30k/40k * 0.5
    expect(w.get('manifold:m1')).toBeCloseTo(0.5, 6); // only manifold market
    const total = [...w.values()].reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('gives a single source the full weight', () => {
    const markets = [
      mk('p1', '2026-07-01', 0.4, { usd: 10_000 }),
      mk('p2', '2026-07-01', 0.4, { usd: 10_000 }),
    ];
    const w = marketWeights(qualifyMarkets(markets));
    expect(w.get('p1')).toBeCloseTo(0.5, 6);
    expect(w.get('p2')).toBeCloseTo(0.5, 6);
  });
});

describe('deriveSelections', () => {
  it('returns nulls without qualified markets', () => {
    expect(deriveSelections([], NOW)).toEqual({ closest: null, optimistic: null });
  });

  it('closest = nearest future date; tie → higher probability', () => {
    const markets = [
      mk('soon', '2026-07-01', 0.3),
      mk('soonHi', '2026-07-01', 0.45), // same date, higher prob
      mk('later', '2026-12-01', 0.6),
      mk('past', '2026-01-01', 0.9),
    ];
    const { closest } = deriveSelections(markets, NOW);
    expect(closest?.marketId).toBe('soonHi');
  });

  it('optimistic = highest probability; tie → nearest today', () => {
    const markets = [
      mk('a', '2027-06-01', 0.7),
      mk('b', '2026-09-01', 0.7), // same prob, nearer today
      mk('c', '2026-12-01', 0.5),
    ];
    const { optimistic } = deriveSelections(markets, NOW);
    expect(optimistic?.marketId).toBe('b');
  });

  it('closest falls back to nearest overall when none are future', () => {
    const markets = [
      mk('older', '2025-01-01', 0.3),
      mk('recent', '2026-05-01', 0.6), // closest to NOW (2026-06-01)
    ];
    const { closest } = deriveSelections(markets, NOW);
    expect(closest?.marketId).toBe('recent');
  });
});

describe('deriveConsensus', () => {
  it('is the liquidity-weighted centroid (date + probability)', () => {
    const d1 = Date.parse('2026-07-01T00:00:00.000Z');
    const d2 = Date.parse('2027-07-01T00:00:00.000Z');
    // one poly + one manifold ⇒ 50/50 weights.
    const markets = [
      mk('p', '2026-07-01', 0.2, { usd: 10_000 }),
      mani('m', '2027-07-01', 0.8, 1_000),
    ];
    const c = deriveConsensus(markets);
    expect(c?.probability).toBeCloseTo(0.5, 6);
    expect(c?.dateMs).toBe(Math.round((d1 + d2) / 2));
  });

  it('returns null without qualified markets', () => {
    expect(deriveConsensus([mk('a', '2026-07-01', 0.5, { usd: 1_000 })])).toBeNull();
  });
});

describe('snapshot builders', () => {
  const markets = [
    mk('p1', '2026-07-01', 0.3, { usd: 20_000 }),
    mani('m1', '2026-09-01', 0.6, 1_000),
  ];
  const ts = '2026-05-20T08:00:00.000Z';

  it('marketHistorySnapshots: one price row per qualified market, keyed by id', () => {
    const snaps = marketHistorySnapshots(markets, ts);
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.metric === MARKET_PRICE_METRIC && s.ts === ts)).toBe(true);
    const p1 = snaps.find((s) => s.source === 'p1');
    expect(p1?.value).toBe(0.3);
    expect(JSON.parse(p1?.raw_blob as string).liquidity_unit).toBe('usd');
    const m1 = snaps.find((s) => s.source === 'manifold:m1');
    expect(JSON.parse(m1?.raw_blob as string).liquidity_unit).toBe('mana');
  });

  it('consensusSnapshots: probability + date rows', () => {
    const snaps = consensusSnapshots(markets, ts);
    const metrics = snaps.map((s) => s.metric).sort();
    expect(metrics).toEqual([CONSENSUS_DATE_METRIC, CONSENSUS_PROB_METRIC].sort());
    expect(snaps.every((s) => s.source === CARD_SOURCE)).toBe(true);
  });

  it('allDerivedSnapshots: market history + consensus together', () => {
    const snaps = allDerivedSnapshots(markets, ts);
    expect(snaps.filter((s) => s.metric === MARKET_PRICE_METRIC)).toHaveLength(2);
    expect(snaps.filter((s) => s.source === CARD_SOURCE)).toHaveLength(2);
  });
});
