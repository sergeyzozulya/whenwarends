import { describe, it, expect } from 'vitest';
import {
  createWorldBankCollector,
  mapWorldBankResponse,
  yearToIsoUtc,
  indicatorUrl,
  WORLDBANK_SOURCE,
  type JsonFetcher,
} from '../../../src/lib/sources/worldbank';
import { WorldBankResponseSchema } from '../../../src/lib/sources/worldbank.schema';

// Realistic World Bank Indicators API v2 payloads. The response is a 2-element
// array: [meta, datapoints[]]. Datapoints are newest-year-first and the most
// recent years are commonly `null` placeholders.

const gdpResponse = [
  {
    page: 1,
    pages: 1,
    per_page: 100,
    total: 4,
    sourceid: '2',
    lastupdated: '2024-09-19',
  },
  [
    {
      indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2024',
      value: null,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
    {
      indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2023',
      value: 3.6,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
    {
      indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2022',
      value: -1.2,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
    {
      indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2021',
      value: 5.9,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
  ],
];

const cpiResponse = [
  { page: 1, pages: 1, per_page: 100, total: 2, sourceid: '2', lastupdated: '2024-09-19' },
  [
    {
      indicator: { id: 'FP.CPI.TOTL.ZG', value: 'Inflation, consumer prices (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2023',
      value: 5.9,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
    {
      indicator: { id: 'FP.CPI.TOTL.ZG', value: 'Inflation, consumer prices (annual %)' },
      country: { id: 'RU', value: 'Russian Federation' },
      countryiso3code: 'RUS',
      date: '2022',
      value: 13.75,
      unit: '',
      obs_status: '',
      decimal: 1,
    },
  ],
];

// API shape when there is no series for the country/indicator: a 2-element
// array whose data element is null (not []).
const emptyResponse = [
  { page: 0, pages: 0, per_page: 100, total: 0, sourceid: null, lastupdated: '2024-09-19' },
  null,
];

describe('WorldBankResponseSchema', () => {
  it('parses the [meta, data] 2-tuple', () => {
    const parsed = WorldBankResponseSchema.parse(gdpResponse);
    expect(parsed).toHaveLength(2);
    const [meta, data] = parsed;
    expect(meta.total).toBe(4);
    expect(data).not.toBeNull();
    expect(data?.[1]?.date).toBe('2023');
    expect(data?.[1]?.value).toBe(3.6);
  });

  it('accepts a null data element (no series available)', () => {
    const [meta, data] = WorldBankResponseSchema.parse(emptyResponse);
    expect(data).toBeNull();
    expect(meta.total).toBe(0);
  });

  it('rejects garbage (not a 2-tuple)', () => {
    expect(() => WorldBankResponseSchema.parse({ not: 'an array' })).toThrow();
    expect(() => WorldBankResponseSchema.parse([{}])).toThrow();
    expect(() => WorldBankResponseSchema.parse([])).toThrow();
  });

  it('rejects a datapoint whose value is a string instead of number|null', () => {
    const bad = [
      gdpResponse[0],
      [{ ...(gdpResponse[1] as unknown[])[1], value: '3.6' }],
    ];
    expect(() => WorldBankResponseSchema.parse(bad)).toThrow();
  });
});

describe('yearToIsoUtc', () => {
  it('maps a 4-digit year to the UTC start-of-year ISO instant', () => {
    expect(yearToIsoUtc('2023')).toBe('2023-01-01T00:00:00.000Z');
    expect(yearToIsoUtc('1999')).toBe('1999-01-01T00:00:00.000Z');
  });

  it('returns undefined for non-4-digit-year garbage', () => {
    expect(yearToIsoUtc('not-a-year')).toBeUndefined();
    expect(yearToIsoUtc('23')).toBeUndefined();
    expect(yearToIsoUtc('2023-04')).toBeUndefined();
    expect(yearToIsoUtc('')).toBeUndefined();
  });
});

describe('indicatorUrl', () => {
  it('builds the documented public World Bank v2 endpoint', () => {
    expect(indicatorUrl('NY.GDP.MKTP.KD.ZG')).toBe(
      'https://api.worldbank.org/v2/country/RUS/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=100'
    );
  });
});

describe('mapWorldBankResponse', () => {
  it('emits one snapshot per non-null year as a UTC ISO ts', () => {
    const snaps = mapWorldBankResponse(gdpResponse, 'ru_gdp_growth');
    expect(Array.isArray(snaps)).toBe(true);
    expect(snaps.length).toBeGreaterThanOrEqual(2); // 2023, 2022, …
    expect(snaps.every((s) => s.metric === 'ru_gdp_growth')).toBe(true);
    expect(snaps.every((s) => s.source === WORLDBANK_SOURCE)).toBe(true);
    expect(snaps.every((s) => s.confidence === 1)).toBe(true);
    // 2024 is null → skipped, never fabricated.
    expect(snaps.some((s) => s.ts === '2024-01-01T00:00:00.000Z')).toBe(false);
    const y2023 = snaps.find((s) => s.ts === '2023-01-01T00:00:00.000Z');
    expect(y2023?.value).toBe(3.6);
    const y2022 = snaps.find((s) => s.ts === '2022-01-01T00:00:00.000Z');
    expect(y2022?.value).toBe(-1.2); // negatives kept (not clamped 0–1)
  });

  it('returns [] when the data element is null (no series)', () => {
    expect(mapWorldBankResponse(emptyResponse, 'ru_gdp_growth')).toEqual([]);
  });

  it('returns [] when every observation is null', () => {
    const allNull = [
      gdpResponse[0],
      [
        { indicator: { id: 'X', value: 'X' }, country: { id: 'RU' }, date: '2024', value: null },
        { indicator: { id: 'X', value: 'X' }, country: { id: 'RU' }, date: '2023', value: null },
      ],
    ];
    expect(mapWorldBankResponse(allNull, 'ru_gdp_growth')).toEqual([]);
  });

  it('throws on garbage input (Zod boundary)', () => {
    expect(() => mapWorldBankResponse('totally not json shape', 'ru_gdp_growth')).toThrow();
    expect(() => mapWorldBankResponse(null, 'ru_gdp_growth')).toThrow();
  });
});

describe('createWorldBankCollector', () => {
  it('fetches each indicator URL and emits its full annual series', async () => {
    const seen: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      seen.push(url);
      if (url.includes('NY.GDP.MKTP.KD.ZG')) return gdpResponse;
      if (url.includes('FP.CPI.TOTL.ZG')) return cpiResponse;
      throw new Error(`unexpected url ${url}`);
    };

    const collector = createWorldBankCollector(fetcher);
    expect(collector.name).toBe('worldbank');

    const result = await collector.run({} as never);
    expect(seen).toHaveLength(2);

    const metrics = new Set(result.snapshots.map((s) => s.metric));
    expect(metrics).toEqual(new Set(['ru_gdp_growth', 'ru_inflation']));

    const gdp2023 = result.snapshots.find(
      (s) => s.metric === 'ru_gdp_growth' && s.ts === '2023-01-01T00:00:00.000Z'
    );
    const cpi2023 = result.snapshots.find(
      (s) => s.metric === 'ru_inflation' && s.ts === '2023-01-01T00:00:00.000Z'
    );
    expect(gdp2023?.value).toBe(3.6);
    expect(cpi2023?.value).toBe(5.9);
    expect(result.markets).toBeUndefined();
  });

  it('isolates a single failing indicator without sinking the rest', async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes('NY.GDP.MKTP.KD.ZG')) return gdpResponse;
      if (url.includes('FP.CPI.TOTL.ZG')) return { garbage: true };
      throw new Error(`unexpected url ${url}`);
    };

    const collector = createWorldBankCollector(fetcher);
    const result = await collector.run({} as never);

    // CPI payload is garbage → dropped; GDP series still produced.
    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.snapshots.every((s) => s.metric === 'ru_gdp_growth')).toBe(
      true
    );
  });

  it('skips an indicator whose series is empty (null data)', async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes('NY.GDP.MKTP.KD.ZG')) return emptyResponse;
      if (url.includes('FP.CPI.TOTL.ZG')) return cpiResponse;
      throw new Error(`unexpected url ${url}`);
    };

    const collector = createWorldBankCollector(fetcher);
    const result = await collector.run({} as never);

    expect(result.snapshots.length).toBeGreaterThan(0);
    expect(result.snapshots.every((s) => s.metric === 'ru_inflation')).toBe(
      true
    );
  });
});
