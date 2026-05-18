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
  it('picks the latest non-null observation and emits a UTC ISO ts', () => {
    const snap = mapWorldBankResponse(gdpResponse, 'ru_gdp_growth');
    expect(snap).not.toBeNull();
    expect(snap?.metric).toBe('ru_gdp_growth');
    expect(snap?.source).toBe(WORLDBANK_SOURCE);
    // 2024 is null -> latest real observation is 2023.
    expect(snap?.ts).toBe('2023-01-01T00:00:00.000Z');
    expect(snap?.value).toBe(3.6);
    expect(snap?.confidence).toBe(1);
  });

  it('keeps negative macro percentages as-is (not clamped to 0–1)', () => {
    const onlyNegative = [
      gdpResponse[0],
      [
        {
          indicator: { id: 'NY.GDP.MKTP.KD.ZG', value: 'GDP growth (annual %)' },
          country: { id: 'RU', value: 'Russian Federation' },
          countryiso3code: 'RUS',
          date: '2022',
          value: -1.2,
        },
      ],
    ];
    const snap = mapWorldBankResponse(onlyNegative, 'ru_gdp_growth');
    expect(snap?.value).toBe(-1.2);
    expect(snap?.ts).toBe('2022-01-01T00:00:00.000Z');
  });

  it('returns null when the data element is null (no series)', () => {
    expect(mapWorldBankResponse(emptyResponse, 'ru_gdp_growth')).toBeNull();
  });

  it('returns null when all observations are null', () => {
    const allNull = [
      gdpResponse[0],
      [
        { indicator: { id: 'X', value: 'X' }, country: { id: 'RU' }, date: '2024', value: null },
        { indicator: { id: 'X', value: 'X' }, country: { id: 'RU' }, date: '2023', value: null },
      ],
    ];
    expect(mapWorldBankResponse(allNull, 'ru_gdp_growth')).toBeNull();
  });

  it('throws on garbage input (Zod boundary)', () => {
    expect(() => mapWorldBankResponse('totally not json shape', 'ru_gdp_growth')).toThrow();
    expect(() => mapWorldBankResponse(null, 'ru_gdp_growth')).toThrow();
  });
});

describe('createWorldBankCollector', () => {
  it('fetches each indicator URL and emits one snapshot per indicator', async () => {
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

    const metrics = result.snapshots.map((s) => s.metric).sort();
    expect(metrics).toEqual(['ru_gdp_growth', 'ru_inflation']);

    const gdp = result.snapshots.find((s) => s.metric === 'ru_gdp_growth');
    const cpi = result.snapshots.find((s) => s.metric === 'ru_inflation');
    expect(gdp?.value).toBe(3.6);
    expect(gdp?.ts).toBe('2023-01-01T00:00:00.000Z');
    expect(cpi?.value).toBe(5.9);
    expect(cpi?.ts).toBe('2023-01-01T00:00:00.000Z');
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

    // CPI payload is garbage -> dropped; GDP still produced.
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.metric).toBe('ru_gdp_growth');
  });

  it('skips an indicator whose series is empty (null data)', async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes('NY.GDP.MKTP.KD.ZG')) return emptyResponse;
      if (url.includes('FP.CPI.TOTL.ZG')) return cpiResponse;
      throw new Error(`unexpected url ${url}`);
    };

    const collector = createWorldBankCollector(fetcher);
    const result = await collector.run({} as never);

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.metric).toBe('ru_inflation');
  });
});
