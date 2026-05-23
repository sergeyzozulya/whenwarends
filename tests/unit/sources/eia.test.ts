import { describe, it, expect } from 'vitest';
import {
  createEiaCollector,
  mapEiaResponse,
  periodToIsoUtc,
  brentUrl,
  EIA_SOURCE,
  OIL_BRENT_METRIC,
  BRENT_SERIES,
  type JsonFetcher,
} from '../../../src/lib/sources/eia';
import { EiaResponseSchema } from '../../../src/lib/sources/eia.schema';

// Realistic EIA Open Data API v2 payload for the daily Brent spot series.
// `value` is observed as both numbers and numeric strings across EIA routes;
// the schema accepts either and the mapper coerces + filters non-finite.
const brentResponse = {
  response: {
    total: 4,
    dateFormat: 'YYYY-MM-DD',
    frequency: 'daily',
    data: [
      {
        period: '2022-01-03',
        series: 'RBRTE',
        'series-description': 'Europe Brent Spot Price FOB (Dollars per Barrel)',
        value: 78.98,
        units: '$/BBL',
      },
      { period: '2022-01-04', series: 'RBRTE', value: '80.0', units: '$/BBL' },
      // A holiday/no-trade day comes back null → must be skipped, not 0.
      { period: '2022-01-05', series: 'RBRTE', value: null, units: '$/BBL' },
      { period: '2026-05-20', series: 'RBRTE', value: 64.2, units: '$/BBL' },
    ],
  },
  request: {},
  apiVersion: '2.1.8',
};

describe('EiaResponseSchema', () => {
  it('parses the response envelope and tolerates extra columns', () => {
    const parsed = EiaResponseSchema.parse(brentResponse);
    expect(parsed.response.data).toHaveLength(4);
    expect(parsed.response.data[0].period).toBe('2022-01-03');
    expect(parsed.response.data[0].value).toBe(78.98);
  });

  it('rejects a payload missing response.data', () => {
    expect(() => EiaResponseSchema.parse({ response: {} })).toThrow();
    expect(() => EiaResponseSchema.parse({ foo: 1 })).toThrow();
  });
});

describe('periodToIsoUtc', () => {
  it('maps a daily YYYY-MM-DD period to a midnight-Z instant', () => {
    expect(periodToIsoUtc('2022-01-03')).toBe('2022-01-03T00:00:00.000Z');
  });
  it('returns undefined for non-daily/garbage periods', () => {
    expect(periodToIsoUtc('2022-01')).toBeUndefined();
    expect(periodToIsoUtc('2022')).toBeUndefined();
    expect(periodToIsoUtc('nope')).toBeUndefined();
  });
});

describe('brentUrl', () => {
  it('builds the documented EIA v2 spot-price endpoint with the Brent series', () => {
    const url = brentUrl('KEY123');
    expect(url).toContain('https://api.eia.gov/v2/petroleum/pri/spt/data/');
    expect(url).toContain('api_key=KEY123');
    expect(url).toContain(`facets[series][]=${BRENT_SERIES}`);
    expect(url).toContain('frequency=daily');
    expect(url).toContain('start=2022-01-01');
  });
});

describe('mapEiaResponse', () => {
  it('emits one snapshot per real numeric price; skips null rows', () => {
    const snaps = mapEiaResponse(brentResponse);
    expect(snaps).toHaveLength(3); // the null 2022-01-05 row is dropped
    expect(snaps.every((s) => s.metric === OIL_BRENT_METRIC)).toBe(true);
    expect(snaps.every((s) => s.source === EIA_SOURCE)).toBe(true);
    expect(snaps.every((s) => s.confidence === 1)).toBe(true);

    const first = snaps.find((s) => s.ts === '2022-01-03T00:00:00.000Z');
    expect(first?.value).toBe(78.98);
    // Numeric-string value coerced to a number.
    const second = snaps.find((s) => s.ts === '2022-01-04T00:00:00.000Z');
    expect(second?.value).toBe(80);
    // Null-value day never fabricated.
    expect(snaps.some((s) => s.ts === '2022-01-05T00:00:00.000Z')).toBe(false);
  });

  it('throws on garbage input (Zod boundary)', () => {
    expect(() => mapEiaResponse(null)).toThrow();
    expect(() => mapEiaResponse({ nope: true })).toThrow();
  });
});

describe('createEiaCollector', () => {
  it('reads EIA_API_KEY, fetches Brent, and emits the daily series', async () => {
    const seen: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      seen.push(url);
      return brentResponse;
    };
    const collector = createEiaCollector(fetcher);
    expect(collector.name).toBe('eia');

    const result = await collector.run({ EIA_API_KEY: 'KEY123' } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('api_key=KEY123');
    expect(result.snapshots.length).toBe(3);
    expect(result.markets).toBeUndefined();
  });

  it('throws a clear, isolatable error when the API key is absent', async () => {
    const collector = createEiaCollector(async () => brentResponse);
    await expect(collector.run({} as never)).rejects.toThrow(/EIA_API_KEY/);
  });

  it('throws when EIA returns no parseable rows', async () => {
    const empty = { response: { data: [] } };
    const collector = createEiaCollector(async () => empty);
    await expect(
      collector.run({ EIA_API_KEY: 'KEY123' } as never)
    ).rejects.toThrow(/no parseable Brent rows/);
  });
});
