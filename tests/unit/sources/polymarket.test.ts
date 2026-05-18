import { describe, it, expect } from 'vitest';
import {
  createPolymarketCollector,
  mapPolymarketResponse,
  POLYMARKET_SOURCE,
  WAR_END_METRIC,
  type JsonFetcher,
} from '../../../src/lib/sources/polymarket';
import type { Env } from '../../../src/lib/types';

// Realistic Polymarket Gamma API sample. Numerics are JSON strings (as the
// real API returns them) and outcomePrices/outcomes are JSON-encoded arrays.
const SAMPLE_PAYLOAD: unknown = [
  {
    id: 250123,
    question: 'Will the Russia-Ukraine war end in 2026?',
    slug: 'russia-ukraine-war-end-2026',
    endDate: '2026-12-31T12:00:00Z',
    createdAt: '2026-01-02T08:00:00Z',
    updatedAt: '2026-05-17T09:30:00Z',
    closed: false,
    active: true,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.31", "0.69"]',
    liquidityNum: '125000.5',
    volumeNum: '4200000',
    lastTradePrice: '0.30',
  },
  {
    id: '250777',
    question: 'Will there be a Ukraine ceasefire before July 2026?',
    slug: 'ukraine-ceasefire-july-2026',
    endDate: '2026-06-30T23:59:00Z',
    closed: false,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.18", "0.82"]',
    liquidity: '50000',
  },
  {
    // Non-war market — must be filtered out.
    id: 999001,
    question: 'Will Bitcoin reach $200k in 2026?',
    endDate: '2026-12-31T00:00:00Z',
    closed: false,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.12", "0.88"]',
    liquidityNum: '900000',
  },
  {
    // Closed war market — must be skipped.
    id: 888001,
    question: 'Will the Russia-Ukraine war end before May 2026?',
    endDate: '2026-04-30T00:00:00Z',
    closed: true,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.05", "0.95"]',
    liquidityNum: '10000',
  },
];

const NOW = '2026-05-18T00:00:00.000Z';

const fakeEnv = {} as Env;

describe('mapPolymarketResponse', () => {
  it('parses the payload and emits one aggregate snapshot', () => {
    const { snapshots } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    expect(snapshots).toHaveLength(1);
    const s = snapshots[0];
    expect(s.metric).toBe(WAR_END_METRIC);
    expect(s.source).toBe(POLYMARKET_SOURCE);
    expect(s.ts).toBe(NOW);
  });

  it('produces a liquidity-weighted probability in [0, 1]', () => {
    const { snapshots } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    const v = snapshots[0].value;
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThanOrEqual(0);
    expect(v as number).toBeLessThanOrEqual(1);
    // Liquidity-weighted mean of 0.31 (w=125000.5) and 0.18 (w=50000).
    const expected =
      (0.31 * 125000.5 + 0.18 * 50000) / (125000.5 + 50000);
    expect(v as number).toBeCloseTo(expected, 6);
  });

  it('maps only qualifying war-end markets, skipping closed and off-topic', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    expect(markets).toBeDefined();
    const rows = markets ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.market_id).sort()).toEqual([
      'polymarket:250123',
      'polymarket:250777',
    ]);
    for (const r of rows) {
      expect(r.source).toBe(POLYMARKET_SOURCE);
      expect(r.category).toBe('war_end');
      expect(r.current_price).not.toBeNull();
      expect(r.current_price as number).toBeGreaterThanOrEqual(0);
      expect(r.current_price as number).toBeLessThanOrEqual(1);
    }
  });

  it('normalises dates to ISO-8601 UTC with a Z suffix', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    for (const r of markets ?? []) {
      expect(r.resolution_date).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(new Date(r.resolution_date).toISOString()).toBe(r.resolution_date);
      expect(r.last_updated).toBe(NOW);
    }
  });

  it('carries through liquidity in USD when present', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    const byId = new Map((markets ?? []).map((r) => [r.market_id, r]));
    expect(byId.get('polymarket:250123')?.liquidity_usd).toBeCloseTo(125000.5, 4);
    expect(byId.get('polymarket:250777')?.liquidity_usd).toBe(50000);
  });

  it('sets confidence proportional to qualifying market count', () => {
    const { snapshots } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    // 2 qualifying markets => 2/3 confidence.
    expect(snapshots[0].confidence).toBeCloseTo(2 / 3, 6);
  });

  it('returns no snapshot when no markets qualify', () => {
    const onlyOffTopic: unknown = [
      {
        id: 1,
        question: 'Will it rain in London tomorrow?',
        endDate: '2026-06-01T00:00:00Z',
        closed: false,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.4","0.6"]',
      },
    ];
    const result = mapPolymarketResponse(onlyOffTopic, NOW);
    expect(result.snapshots).toHaveLength(0);
    expect(result.markets).toHaveLength(0);
  });

  it('throws on a garbage (non-array) response', () => {
    expect(() => mapPolymarketResponse({ error: 'rate limited' }, NOW)).toThrow();
    expect(() => mapPolymarketResponse(null, NOW)).toThrow();
    expect(() => mapPolymarketResponse('not json', NOW)).toThrow();
  });

  it('falls back to lastTradePrice when outcomePrices is malformed', () => {
    const payload: unknown = [
      {
        id: 42,
        question: 'Will the Russia-Ukraine war end in 2027?',
        endDate: '2027-12-31T00:00:00Z',
        closed: false,
        outcomes: 'not-an-array',
        outcomePrices: '{bad json',
        lastTradePrice: '0.22',
        liquidityNum: '1000',
      },
    ];
    const { markets, snapshots } = mapPolymarketResponse(payload, NOW);
    expect(markets?.[0].current_price).toBeCloseTo(0.22, 6);
    expect(snapshots[0].value as number).toBeCloseTo(0.22, 6);
  });

  it('clamps out-of-range prices into [0, 1]', () => {
    const payload: unknown = [
      {
        id: 7,
        question: 'Will the Russia-Ukraine war end soon (ceasefire)?',
        endDate: '2026-09-01T00:00:00Z',
        closed: false,
        outcomes: '["Yes","No"]',
        outcomePrices: '["1.4","-0.4"]',
      },
    ];
    const { markets } = mapPolymarketResponse(payload, NOW);
    expect(markets?.[0].current_price).toBe(1);
  });
});

describe('createPolymarketCollector', () => {
  it('exposes the stable source name', () => {
    const c = createPolymarketCollector(async () => []);
    expect(c.name).toBe(POLYMARKET_SOURCE);
  });

  it('fetches via the injected fetcher and returns mapped result', async () => {
    let calledUrl = '';
    const mockFetcher: JsonFetcher = async (url) => {
      calledUrl = url;
      return SAMPLE_PAYLOAD;
    };
    const collector = createPolymarketCollector(mockFetcher);
    const result = await collector.run(fakeEnv);
    expect(calledUrl).toContain('gamma-api.polymarket.com');
    expect(result.snapshots).toHaveLength(1);
    expect(result.markets).toHaveLength(2);
    // ts should be a real ISO-8601 UTC timestamp generated at run time.
    expect(result.snapshots[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('propagates fetcher errors so the runner can record failure', async () => {
    const collector = createPolymarketCollector(async () => {
      throw new Error('network down');
    });
    await expect(collector.run(fakeEnv)).rejects.toThrow('network down');
  });
});
