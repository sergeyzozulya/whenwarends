import { describe, it, expect } from 'vitest';
import {
  createManifoldCollector,
  mapManifoldMarkets,
  MANIFOLD_SOURCE,
} from '../../../src/lib/sources/manifold';
import type { ManifoldSearchMarket } from '../../../src/lib/sources/manifold.schema';
import type { Env } from '../../../src/lib/types';

const NOW = '2026-05-20T00:00:00.000Z';

const m = (over: Partial<ManifoldSearchMarket>): ManifoldSearchMarket => ({
  id: 'x',
  question: 'Russia x Ukraine ceasefire by August 1, 2026?',
  outcomeType: 'BINARY',
  probability: 0.66,
  closeTime: Date.parse('2026-12-31T00:00:00Z'),
  isResolved: false,
  totalLiquidity: 200,
  volume: 9000,
  ...over,
});

describe('mapManifoldMarkets', () => {
  it('keeps only open binary war-end markets with liquidity', () => {
    const rows = mapManifoldMarkets(
      [
        [
          m({ id: 'good' }),
          m({ id: 'resolved', isResolved: true }),
          m({ id: 'multi', outcomeType: 'MULTIPLE_CHOICE' }),
          m({ id: 'offtopic', question: 'Will Bitcoin hit $100k in 2026?' }),
          m({ id: 'dead', totalLiquidity: 0 }),
        ],
      ],
      NOW
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.market_id).toBe('manifold:good');
    expect(r.source).toBe(MANIFOLD_SOURCE);
    expect(r.current_price).toBeCloseTo(0.66, 6);
    expect(r.liquidity_mana).toBe(200);
    expect(r.liquidity_usd).toBeNull();
  });

  it('derives the resolution date from the question text', () => {
    const rows = mapManifoldMarkets([[m({ id: 'g' })]], NOW);
    expect(rows[0].resolution_date).toBe('2026-08-01T00:00:00.000Z');
  });

  it('dedupes the same market id across search lists', () => {
    const rows = mapManifoldMarkets([[m({ id: 'g' })], [m({ id: 'g' })]], NOW);
    expect(rows).toHaveLength(1);
  });
});

describe('manifold collector', () => {
  it('searches and returns markets (no aggregate snapshots)', async () => {
    const collector = createManifoldCollector({
      fetchJson: async () => [m({ id: 'g' }), m({ id: 'off', question: 'foo' })],
    });
    const result = await collector.run({} as unknown as Env);
    expect(result.snapshots).toEqual([]);
    expect(result.markets).toHaveLength(1);
    expect(result.markets?.[0].market_id).toBe('manifold:g');
  });

  it('throws when every search term fails', async () => {
    const collector = createManifoldCollector({
      fetchJson: async () => {
        throw new Error('down');
      },
    });
    await expect(collector.run({} as unknown as Env)).rejects.toThrow();
  });
});
