import { describe, it, expect } from 'vitest';
import {
  collectKalshi,
  kalshiCollector,
  SOURCE,
  METRIC_WAR_END_PROBABILITY,
  type JsonFetcher,
} from '../../../src/lib/sources/kalshi';

// Realistic Kalshi /trade-api/v2/markets sample payload.
// Prices are integer cents (0–100); timestamps are ISO-8601 UTC.
const sampleResponse = {
  cursor: 'CgkI…',
  markets: [
    {
      ticker: 'KXRUSUKRWAR-26DEC31-Y',
      event_ticker: 'KXRUSUKRWAR-26DEC31',
      series_ticker: 'KXRUSUKRWAR',
      title: 'Will the Russia-Ukraine war end by Dec 31, 2026?',
      subtitle: 'Yes',
      status: 'active',
      yes_bid: 22,
      yes_ask: 26,
      last_price: 24,
      open_time: '2025-01-02T15:00:00Z',
      close_time: '2026-12-31T23:59:59Z',
      expiration_time: '2027-01-02T15:00:00Z',
      volume: 184213,
      liquidity: 90250,
      category: 'World',
    },
    {
      ticker: 'KXRUSUKRWAR-27JUN30-Y',
      event_ticker: 'KXRUSUKRWAR-27JUN30',
      series_ticker: 'KXRUSUKRWAR',
      title: 'Will the Russia-Ukraine war end by Jun 30, 2027?',
      // No subtitle; non-Z but still ISO-8601 UTC offset to prove
      // canonicalisation through Date#toISOString().
      status: 'open',
      last_price: 48,
      close_time: '2027-06-30T23:59:59+00:00',
      volume: 5120,
    },
    {
      // Settled market: still parses, but is excluded from snapshots/markets.
      ticker: 'KXRUSUKRWAR-25DEC31-Y',
      title: 'Will the Russia-Ukraine war end by Dec 31, 2025?',
      status: 'settled',
      yes_bid: 0,
      yes_ask: 0,
      last_price: 0,
      close_time: '2025-12-31T23:59:59Z',
    },
  ],
};

const mockFetcher =
  (payload: unknown): JsonFetcher =>
  async () =>
    payload;

describe('kalshi collector', () => {
  it('parses, filters to live markets, and maps to snapshots', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));

    // Only the 2 live (active/open) markets become snapshots.
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
      (s.raw_blob ?? '').includes('26DEC31')
    );
    expect(first).toBeDefined();
    // mid of 22/26 cents = 24 cents = 0.24
    expect(first?.value).toBeCloseTo(0.24, 10);
    // spread = 4 cents → confidence = 1 - 0.04 = 0.96
    expect(first?.confidence).toBeCloseTo(0.96, 10);
  });

  it('falls back to last_price when no two-sided quote and lowers confidence', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));
    const second = result.snapshots.find((s) =>
      (s.raw_blob ?? '').includes('27JUN30')
    );
    expect(second).toBeDefined();
    // last_price 48 cents → 0.48
    expect(second?.value).toBeCloseTo(0.48, 10);
    // no bid/ask → fixed low confidence 0.3
    expect(second?.confidence).toBeCloseTo(0.3, 10);
  });

  it('maps market rows with 0–1 price and canonical UTC resolution date', async () => {
    const result = await collectKalshi(mockFetcher(sampleResponse));
    expect(result.markets).toBeDefined();
    expect(result.markets).toHaveLength(2);

    const m1 = result.markets?.find(
      (m) => m.market_id === 'KXRUSUKRWAR-26DEC31-Y'
    );
    expect(m1).toBeDefined();
    expect(m1?.source).toBe(SOURCE);
    expect(m1?.question).toContain('—'); // title — subtitle joined
    expect(m1?.current_price).toBeCloseTo(0.24, 10);
    expect(m1?.liquidity_usd).toBe(90250);
    // resolution from expiration_time, canonicalised to Z.
    expect(m1?.resolution_date).toBe('2027-01-02T15:00:00.000Z');
    expect(m1?.last_updated).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    const m2 = result.markets?.find(
      (m) => m.market_id === 'KXRUSUKRWAR-27JUN30-Y'
    );
    // No expiration_time → falls back to close_time, offset → Z.
    expect(m2?.resolution_date).toBe('2027-06-30T23:59:59.000Z');
    // No liquidity → falls back to volume.
    expect(m2?.liquidity_usd).toBe(5120);
  });

  it('handles an empty market list without throwing', async () => {
    const result = await collectKalshi(mockFetcher({ markets: [] }));
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
          markets: [{ ticker: 'X', title: 'no status / close_time' }],
        })
      )
    ).rejects.toThrow();

    await expect(collectKalshi(mockFetcher(null))).rejects.toThrow();
    await expect(collectKalshi(mockFetcher('not json'))).rejects.toThrow();
  });

  it('rejects out-of-range cents prices (probability invariant)', async () => {
    await expect(
      collectKalshi(
        mockFetcher({
          markets: [
            {
              ticker: 'BAD',
              title: 'bad price',
              status: 'active',
              yes_bid: 10,
              yes_ask: 250, // > 100 cents — must fail Zod
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
