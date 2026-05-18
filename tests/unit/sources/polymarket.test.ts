import { describe, it, expect } from 'vitest';
import {
  createPolymarketCollector,
  mapPolymarketResponse,
  POLYMARKET_SOURCE,
  WAR_END_METRIC,
  type JsonFetcher,
} from '../../../src/lib/sources/polymarket';
import type { Env } from '../../../src/lib/types';

// Realistic Polymarket Gamma /events sample, shaped exactly like the live API
// (verified 2026-05-18): top-level array of events, each with a nested
// markets[] array; numerics as JSON strings; outcomes/outcomePrices as
// JSON-encoded string arrays; grouped markets share ONE event-level endDate
// while the real per-market resolution date lives in the question text.
const SAMPLE_PAYLOAD: unknown = [
  {
    id: '17600',
    slug: 'russia-x-ukraine-ceasefire-agreement-by',
    title: 'Russia x Ukraine ceasefire agreement by...?',
    closed: false,
    active: true,
    endDate: '2026-12-31T00:00:00Z',
    markets: [
      {
        id: 2243894,
        question: 'Russia x Ukraine ceasefire agreement by May 31, 2026?',
        slug: 'russia-x-ukraine-ceasefire-agreement-by-may-31-2026',
        groupItemTitle: 'May 31',
        // Grouped: shared event endDate, NOT the real resolution date.
        endDate: '2026-12-31T00:00:00Z',
        endDateIso: '2026-12-31',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.0275", "0.9725"]',
        liquidityNum: 52424.12488,
        volumeNum: 90000,
        lastTradePrice: 0.03,
        bestBid: 0.025,
        bestAsk: 0.03,
      },
      {
        id: '2243895',
        question: 'Russia x Ukraine ceasefire agreement by June 30, 2026?',
        slug: 'russia-x-ukraine-ceasefire-agreement-by-june-30-2026',
        groupItemTitle: 'June 30',
        endDate: '2026-12-31T00:00:00Z',
        endDateIso: '2026-12-31',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.115", "0.885"]',
        liquidity: '88595.3655',
      },
      {
        id: 2243897,
        question: 'Russia x Ukraine ceasefire agreement by December 31, 2026?',
        slug: 'russia-x-ukraine-ceasefire-agreement-by-december-31-2026',
        groupItemTitle: 'December 31',
        endDate: '2026-12-31T00:00:00Z',
        endDateIso: '2026-12-31',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.505", "0.495"]',
        liquidityNum: '149033.7282',
      },
    ],
  },
  {
    id: '17700',
    slug: 'ukraine-signs-peace-deal-with-russia-before-2027',
    title: 'Ukraine signs peace deal with Russia before 2027?',
    closed: false,
    active: true,
    endDate: '2026-12-31T00:00:00Z',
    markets: [
      {
        id: 665224,
        question: 'Ukraine signs peace deal with Russia before 2027?',
        slug: 'ukraine-signs-peace-deal-with-russia-before-2027',
        groupItemTitle: '',
        endDate: '2026-12-31T00:00:00Z',
        endDateIso: '2026-12-31',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.255", "0.745"]',
        liquidityNum: 52831.5181,
      },
    ],
  },
  {
    // Off-topic event sharing the ukraine tag — every market must be excluded.
    id: '17800',
    slug: 'where-will-trump-and-putin-meet-next',
    title: 'Where will Trump and Putin meet next?',
    closed: false,
    active: true,
    endDate: '2026-06-30T00:00:00Z',
    markets: [
      {
        id: 618500,
        question: 'Will Trump and Putin meet next in Russia?',
        endDate: '2026-06-30T00:00:00Z',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.0415", "0.9585"]',
        liquidityNum: 25434.45571,
      },
      {
        id: 546806,
        question: 'Will Russia capture Kostyantynivka by December 31?',
        endDate: '2025-12-31T12:00:00Z',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.2", "0.8"]',
        liquidityNum: 30000,
      },
      {
        // Tangential: a referendum being *scheduled*, not the war ending.
        id: 700001,
        question: 'Ukraine calls a referendum on peace deal with Russia by January 31?',
        endDate: '2026-01-31T00:00:00Z',
        closed: false,
        active: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.08", "0.92"]',
        liquidityNum: 12000,
      },
    ],
  },
  {
    // Closed war-end market — must be skipped even though it matches text.
    id: '17900',
    slug: 'ukraine-ceasefire-framework-2025',
    title: 'Ukraine ceasefire framework 2025',
    closed: false,
    active: true,
    endDate: '2025-12-31T00:00:00Z',
    markets: [
      {
        id: 711244,
        question: 'Ukraine officially agrees to a US backed ceasefire framework by December 31, 2025?',
        endDate: '2025-12-31T00:00:00Z',
        closed: true,
        active: false,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0", "1"]',
        liquidityNum: 10000,
      },
    ],
  },
];

const NOW = '2026-05-18T00:00:00.000Z';

const fakeEnv = {} as Env;

describe('mapPolymarketResponse', () => {
  it('parses the events payload and emits one aggregate snapshot', () => {
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
    // Liquidity-weighted mean of the 4 qualifying markets.
    const pts = [
      { p: 0.0275, w: 52424.12488 },
      { p: 0.115, w: 88595.3655 },
      { p: 0.505, w: 149033.7282 },
      { p: 0.255, w: 52831.5181 },
    ];
    const num = pts.reduce((a, x) => a + x.p * x.w, 0);
    const den = pts.reduce((a, x) => a + x.w, 0);
    expect(v as number).toBeCloseTo(num / den, 6);
  });

  it('keeps only qualifying war-end markets, excluding off-topic and tangential', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    const rows = markets ?? [];
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.market_id).sort()).toEqual([
      'polymarket:2243894',
      'polymarket:2243895',
      'polymarket:2243897',
      'polymarket:665224',
    ]);
    for (const r of rows) {
      expect(r.source).toBe(POLYMARKET_SOURCE);
      expect(r.category).toBe('war_end');
      expect(r.current_price).not.toBeNull();
      expect(r.current_price as number).toBeGreaterThanOrEqual(0);
      expect(r.current_price as number).toBeLessThanOrEqual(1);
    }
  });

  it('derives the TRUE per-market resolution date from the question (not the shared event endDate)', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    const byId = new Map((markets ?? []).map((r) => [r.market_id, r]));
    // Grouped sub-markets all share endDate=2026-12-31 on the wire, but each
    // must resolve to its own real date parsed from the question text.
    expect(byId.get('polymarket:2243894')?.resolution_date).toBe('2026-05-31T00:00:00.000Z');
    expect(byId.get('polymarket:2243895')?.resolution_date).toBe('2026-06-30T00:00:00.000Z');
    expect(byId.get('polymarket:2243897')?.resolution_date).toBe('2026-12-31T00:00:00.000Z');
    // "before 2027" => end of 2026.
    expect(byId.get('polymarket:665224')?.resolution_date).toBe('2026-12-31T00:00:00.000Z');
    // The CDF needs >1 distinct resolution date; verify spread.
    const distinct = new Set((markets ?? []).map((r) => r.resolution_date));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('normalises every date to ISO-8601 UTC with a Z suffix', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    for (const r of markets ?? []) {
      expect(r.resolution_date).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(new Date(r.resolution_date).toISOString()).toBe(r.resolution_date);
      expect(r.last_updated).toBe(NOW);
    }
  });

  it('carries through liquidity in USD (number or string-encoded)', () => {
    const { markets } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    const byId = new Map((markets ?? []).map((r) => [r.market_id, r]));
    expect(byId.get('polymarket:2243894')?.liquidity_usd).toBeCloseTo(52424.12488, 4);
    expect(byId.get('polymarket:2243895')?.liquidity_usd).toBeCloseTo(88595.3655, 4);
    expect(byId.get('polymarket:2243897')?.liquidity_usd).toBeCloseTo(149033.7282, 4);
  });

  it('sets confidence proportional to qualifying market count (capped at 1)', () => {
    const { snapshots } = mapPolymarketResponse(SAMPLE_PAYLOAD, NOW);
    // 4 qualifying markets => min(1, 4/3) === 1.
    expect(snapshots[0].confidence).toBe(1);
  });

  it('returns no snapshot when no markets qualify', () => {
    const onlyOffTopic: unknown = [
      {
        id: '1',
        slug: 'weather',
        closed: false,
        active: true,
        markets: [
          {
            id: 1,
            question: 'Will it rain in London tomorrow?',
            endDate: '2026-06-01T00:00:00Z',
            closed: false,
            active: true,
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.4","0.6"]',
          },
        ],
      },
    ];
    const result = mapPolymarketResponse(onlyOffTopic, NOW);
    expect(result.snapshots).toHaveLength(0);
    expect(result.markets).toHaveLength(0);
  });

  it('tolerates events with null/empty markets arrays', () => {
    const payload: unknown = [
      { id: '1', slug: 'empty', closed: false, markets: null },
      { id: '2', slug: 'empty2', closed: false },
    ];
    const result = mapPolymarketResponse(payload, NOW);
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
        id: '9',
        slug: 'e',
        closed: false,
        active: true,
        markets: [
          {
            id: 42,
            question: 'Will the Russia-Ukraine war end in 2027?',
            endDate: '2027-12-31T00:00:00Z',
            closed: false,
            active: true,
            outcomes: 'not-an-array',
            outcomePrices: '{bad json',
            lastTradePrice: '0.22',
            liquidityNum: '1000',
          },
        ],
      },
    ];
    const { markets, snapshots } = mapPolymarketResponse(payload, NOW);
    expect(markets?.[0].current_price).toBeCloseTo(0.22, 6);
    expect(markets?.[0].resolution_date).toBe('2027-12-31T00:00:00.000Z');
    expect(snapshots[0].value as number).toBeCloseTo(0.22, 6);
  });

  it('clamps out-of-range prices into [0, 1]', () => {
    const payload: unknown = [
      {
        id: '8',
        slug: 'e',
        closed: false,
        active: true,
        markets: [
          {
            id: 7,
            question: 'Will the Russia-Ukraine war end via ceasefire by September 2026?',
            endDate: '2026-09-01T00:00:00Z',
            closed: false,
            active: true,
            outcomes: '["Yes","No"]',
            outcomePrices: '["1.4","-0.4"]',
          },
        ],
      },
    ];
    const { markets } = mapPolymarketResponse(payload, NOW);
    expect(markets?.[0].current_price).toBe(1);
  });

  it('prefers the labelled "Yes" outcome index when ordering differs', () => {
    const payload: unknown = [
      {
        id: '8',
        slug: 'e',
        closed: false,
        active: true,
        markets: [
          {
            id: 11,
            question: 'Will there be a Russia-Ukraine ceasefire by August 31, 2026?',
            endDate: '2026-12-31T00:00:00Z',
            closed: false,
            active: true,
            // Reversed order: ["No","Yes"] with matching prices.
            outcomes: '["No","Yes"]',
            outcomePrices: '["0.7","0.3"]',
            liquidityNum: 5000,
          },
        ],
      },
    ];
    const { markets } = mapPolymarketResponse(payload, NOW);
    expect(markets?.[0].current_price).toBeCloseTo(0.3, 6);
    expect(markets?.[0].resolution_date).toBe('2026-08-31T00:00:00.000Z');
  });
});

describe('createPolymarketCollector', () => {
  it('exposes the stable source name', () => {
    const c = createPolymarketCollector(async () => []);
    expect(c.name).toBe(POLYMARKET_SOURCE);
  });

  it('fetches the /events endpoint via the injected fetcher and returns mapped result', async () => {
    let calledUrl = '';
    const mockFetcher: JsonFetcher = async (url) => {
      calledUrl = url;
      return SAMPLE_PAYLOAD;
    };
    const collector = createPolymarketCollector(mockFetcher);
    const result = await collector.run(fakeEnv);
    expect(calledUrl).toContain('gamma-api.polymarket.com/events');
    expect(calledUrl).toContain('tag_slug=ukraine');
    expect(result.snapshots).toHaveLength(1);
    expect(result.markets).toHaveLength(4);
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
