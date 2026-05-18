import { describe, it, expect } from 'vitest';
import {
  collectKalshi,
  kalshiCollector,
  SOURCE,
  METRIC_WAR_END_PROBABILITY,
  type JsonFetcher,
} from '../../../src/lib/sources/kalshi';

// Real Kalshi /trade-api/v2/markets sample payload, modeled field-for-field on
// the LIVE response captured 2026-05-18 from external-api.kalshi.com for the
// KXZELENSKYYOUT ladder. Prices are fixed-point DOLLAR STRINGS in [0,1]
// (already the implied probability — no /100). volume_fp / liquidity_dollars
// are fixed-point count strings; timestamps are ISO-8601 UTC.
const sampleResponse = {
  cursor: '',
  markets: [
    {
      ticker: 'KXZELENSKYYOUT-26OCT01',
      event_ticker: 'KXZELENSKYYOUT',
      title: 'Will Volodymyr Zelenskyy leave President of Ukraine before Oct 1, 2026?',
      yes_sub_title: 'Before Oct 1, 2026',
      status: 'active',
      yes_bid_dollars: '0.1300',
      yes_ask_dollars: '0.1700',
      last_price_dollars: '0.3000',
      open_time: '2026-01-23T15:00:00Z',
      close_time: '2026-10-01T03:59:00Z',
      expiration_time: '2026-10-08T14:00:00Z',
      latest_expiration_time: '2026-10-08T14:00:00Z',
      expected_expiration_time: '2026-01-23T15:00:00Z',
      volume_fp: '18139.17',
      volume_24h_fp: '1225.83',
      liquidity_dollars: '0.0000',
    },
    {
      ticker: 'KXZELENSKYYOUT-26JUL01',
      event_ticker: 'KXZELENSKYYOUT',
      title: 'Will Volodymyr Zelenskyy leave President of Ukraine before Jul 1, 2026?',
      yes_sub_title: 'Before Jul 1, 2026',
      status: 'active',
      // No two-sided quote: only last price. Non-Z close_time offset proves
      // canonicalisation through Date#toISOString().
      last_price_dollars: '0.4800',
      close_time: '2026-07-01T03:59:00+00:00',
      volume_fp: '12302.50',
    },
    {
      // Finalized market: still parses, but excluded from snapshots/markets.
      ticker: 'KXZELENSKYYOUT-26APR01',
      event_ticker: 'KXZELENSKYYOUT',
      title: 'Will Volodymyr Zelenskyy leave President of Ukraine before Apr 1, 2026?',
      yes_sub_title: 'Before Apr 1, 2026',
      status: 'finalized',
      yes_bid_dollars: '0.0000',
      yes_ask_dollars: '1.0000',
      last_price_dollars: '0.0100',
      close_time: '2026-04-01T03:59:00Z',
    },
  ],
};

const mockFetcher =
  (payload: unknown): JsonFetcher =>
  async () =>
    payload;

describe('kalshi collector', () => {
  it('parses, filters to active markets, and maps to snapshots', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));

    // Only the 2 active markets become snapshots.
    expect(result.snapshots).toHaveLength(2);
    for (const s of result.snapshots) {
      expect(s.source).toBe(SOURCE);
      expect(s.metric).toBe(METRIC_WAR_END_PROBABILITY);
      // Probability normalised to 0–1.
      expect(s.value).not.toBeNull();
      expect(s.value as number).toBeGreaterThanOrEqual(0);
      expect(s.value as number).toBeLessThanOrEqual(1);
      // ISO-8601 UTC, canonical Z form.
      expect(s.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // confidence is a 0–1 float.
      expect(s.confidence).not.toBeNull();
      expect(s.confidence as number).toBeGreaterThanOrEqual(0);
      expect(s.confidence as number).toBeLessThanOrEqual(1);
      expect(typeof s.raw_blob).toBe('string');
    }
  });

  it('computes bid/ask mid probability and spread-based confidence', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));
    const first = result.snapshots.find((s) =>
      (s.raw_blob ?? '').includes('26OCT01')
    );
    expect(first).toBeDefined();
    // mid of 0.13/0.17 dollars = 0.15
    expect(first?.value).toBeCloseTo(0.15, 10);
    // spread = 0.04 → confidence = 1 - 0.04 = 0.96
    expect(first?.confidence).toBeCloseTo(0.96, 10);
  });

  it('falls back to last_price when no two-sided quote and lowers confidence', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));
    const second = result.snapshots.find((s) =>
      (s.raw_blob ?? '').includes('26JUL01')
    );
    expect(second).toBeDefined();
    // last_price_dollars 0.48 → 0.48
    expect(second?.value).toBeCloseTo(0.48, 10);
    // no bid/ask → fixed low confidence 0.3
    expect(second?.confidence).toBeCloseTo(0.3, 10);
  });

  it('maps market rows with 0–1 price and canonical UTC resolution date', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));
    expect(result.markets).toBeDefined();
    expect(result.markets).toHaveLength(2);

    const m1 = result.markets?.find(
      (m) => m.market_id === 'KXZELENSKYYOUT-26OCT01'
    );
    expect(m1).toBeDefined();
    expect(m1?.source).toBe(SOURCE);
    expect(m1?.question).toContain('—'); // title — yes_sub_title joined
    expect(m1?.current_price).toBeCloseTo(0.15, 10);
    // liquidity_dollars deprecated ("0.0000") → falls back to volume_fp.
    expect(m1?.liquidity_usd).toBeCloseTo(18139.17, 6);
    expect(m1?.category).toBe('war_end');
    // resolution from expiration_time, canonicalised to Z.
    expect(m1?.resolution_date).toBe('2026-10-08T14:00:00.000Z');
    expect(m1?.last_updated).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    const m2 = result.markets?.find(
      (m) => m.market_id === 'KXZELENSKYYOUT-26JUL01'
    );
    // No expiration_time → falls back to close_time, offset → Z.
    expect(m2?.resolution_date).toBe('2026-07-01T03:59:00.000Z');
    // volume_fp coerced from string.
    expect(m2?.liquidity_usd).toBeCloseTo(12302.5, 6);
  });

  it('follows cursor pagination across pages', async () => {
    const page1 = {
      cursor: 'PAGE2',
      markets: [
        {
          ticker: 'KXZELENSKYYOUT-26OCT01',
          status: 'active',
          last_price_dollars: '0.2000',
          close_time: '2026-10-01T03:59:00Z',
        },
      ],
    };
    const page2 = {
      cursor: '',
      markets: [
        {
          ticker: 'KXZELENSKYYOUT-27JAN01',
          status: 'active',
          last_price_dollars: '0.6000',
          close_time: '2027-01-01T03:59:00Z',
        },
      ],
    };
    let call = 0;
    const paging: JsonFetcher = async (url) => {
      call += 1;
      return url.includes('cursor=PAGE2') ? page2 : page1;
    };
    const result = await collectKalshi(paging);
    expect(call).toBe(2);
    expect(result.snapshots).toHaveLength(2);
    expect(result.markets?.map((m) => m.market_id).sort()).toEqual([
      'KXZELENSKYYOUT-26OCT01',
      'KXZELENSKYYOUT-27JAN01',
    ]);
  });

  it('handles an empty market list without throwing', async () => {
    const result = await collectKalshi(mockFetcher({ markets: [], cursor: '' }));
    expect(result.snapshots).toEqual([]);
    expect(result.markets).toEqual([]);
  });

  it('rejects a garbage / contract-drift payload at the Zod boundary', async () => {
    await expect(
      collectKalshi(mockFetcher({ not: 'a kalshi response' }))
    ).rejects.toThrow();

    await expect(
      collectKalshi(
        mockFetcher({
          markets: [{ title: 'no ticker / status' }],
        })
      )
    ).rejects.toThrow();

    await expect(collectKalshi(mockFetcher(null))).rejects.toThrow();
    await expect(collectKalshi(mockFetcher('not json'))).rejects.toThrow();
  });

  it('rejects out-of-range dollar prices (probability invariant)', async () => {
    await expect(
      collectKalshi(
        mockFetcher({
          cursor: '',
          markets: [
            {
              ticker: 'BAD',
              status: 'active',
              yes_bid_dollars: '0.1000',
              yes_ask_dollars: '2.5000', // > 1.0 — must fail Zod
              close_time: '2026-12-31T23:59:59Z',
            },
          ],
        })
      )
    ).rejects.toThrow();
  });

  it('exposes a Collector with the stable source name', () => {
    expect(kalshiCollector.name).toBe('kalshi');
    expect(SOURCE).toBe('kalshi');
    expect(METRIC_WAR_END_PROBABILITY).toBe('war_end_probability');
  });
});
