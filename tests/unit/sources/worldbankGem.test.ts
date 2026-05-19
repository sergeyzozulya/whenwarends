import { describe, it, expect } from 'vitest';
import {
  gemUrl,
  gemPeriodToIsoUtc,
  mapGemSeries,
  quarterlyYoY,
  mapGemGdpYoY,
  createWorldBankGemCollector,
  RU_CPI_YOY_METRIC,
  RU_GDP_YOY_METRIC,
  UA_GDP_YOY_METRIC,
  WORLDBANK_SOURCE,
  type JsonFetcher,
} from '../../../src/lib/sources/worldbank';

// GEM responses are the same [meta, data|null] 2-tuple as the annual API,
// only the `date` differs (YYYYM## / YYYYQ#).
const meta = { page: 1, pages: 1, per_page: 400, total: 3, sourceid: '15', lastupdated: '2026-03-31' };
const dp = (date: string, value: number | null) => ({
  indicator: { id: 'X', value: 'X label' },
  country: { id: 'RU', value: 'Russian Federation' },
  countryiso3code: '',
  date,
  value,
  unit: '',
  obs_status: '',
  decimal: 0,
});

describe('gemUrl', () => {
  it('targets the public GEM source (15) with a date range', () => {
    expect(gemUrl('RUS', 'CPTOTSAXNZGY', '2022M01:2026M12')).toBe(
      'https://api.worldbank.org/v2/country/RUS/indicator/CPTOTSAXNZGY?source=15&format=json&per_page=400&date=2022M01:2026M12'
    );
  });
});

describe('gemPeriodToIsoUtc', () => {
  it('maps a month period to its first day (UTC)', () => {
    expect(gemPeriodToIsoUtc('2024M03')).toBe('2024-03-01T00:00:00.000Z');
    expect(gemPeriodToIsoUtc('2022M01')).toBe('2022-01-01T00:00:00.000Z');
  });
  it('maps a quarter period to its first month (UTC)', () => {
    expect(gemPeriodToIsoUtc('2024Q1')).toBe('2024-01-01T00:00:00.000Z');
    expect(gemPeriodToIsoUtc('2024Q2')).toBe('2024-04-01T00:00:00.000Z');
    expect(gemPeriodToIsoUtc('2024Q4')).toBe('2024-10-01T00:00:00.000Z');
  });
  it('returns undefined for a bare year or garbage (skipped, not thrown)', () => {
    expect(gemPeriodToIsoUtc('2024')).toBeUndefined();
    expect(gemPeriodToIsoUtc('2024M13')).toBeUndefined();
    expect(gemPeriodToIsoUtc('2024Q5')).toBeUndefined();
    expect(gemPeriodToIsoUtc('nope')).toBeUndefined();
  });
});

describe('mapGemSeries', () => {
  it('emits one snapshot per real monthly observation, value as-is', () => {
    const raw = [meta, [dp('2026M02', 5.93), dp('2026M01', null), dp('2022M01', 8.67)]];
    const out = mapGemSeries(raw, RU_CPI_YOY_METRIC);
    expect(out).toHaveLength(2); // the null month is skipped, never invented
    expect(out.every((s) => s.metric === RU_CPI_YOY_METRIC)).toBe(true);
    expect(out.every((s) => s.source === WORLDBANK_SOURCE)).toBe(true);
    const jan = out.find((s) => s.ts === '2022-01-01T00:00:00.000Z');
    expect(jan?.value).toBe(8.67); // percentage kept as-is (not clamped 0–1)
  });
  it('returns [] for a null data element', () => {
    expect(mapGemSeries([meta, null], RU_CPI_YOY_METRIC)).toEqual([]);
  });
  it('throws on a non-tuple payload (Zod boundary)', () => {
    expect(() => mapGemSeries({ nope: true }, RU_CPI_YOY_METRIC)).toThrow();
  });
});

describe('quarterlyYoY', () => {
  it('computes (level / same-quarter-prior-year − 1)·100, base required', () => {
    const yoy = quarterlyYoY([
      { ts: '2021-04-01T00:00:00.000Z', v: 100 },
      { ts: '2022-04-01T00:00:00.000Z', v: 80 }, // −20% vs 2021Q2
      { ts: '2022-01-01T00:00:00.000Z', v: 50 }, // no 2021Q1 base → dropped
    ]);
    expect(yoy).toHaveLength(1);
    expect(yoy[0].ts).toBe('2022-04-01T00:00:00.000Z');
    expect(yoy[0].v).toBeCloseTo(-20, 6);
  });
  it('never bridges a missing base quarter', () => {
    expect(
      quarterlyYoY([{ ts: '2023-07-01T00:00:00.000Z', v: 123 }])
    ).toEqual([]);
  });
});

describe('mapGemGdpYoY', () => {
  it('derives a quarterly % y/y series from official levels', () => {
    const raw = [
      meta,
      [
        dp('2022Q1', 26123),
        dp('2021Q1', 30646),
        dp('2022Q2', 20325),
        dp('2021Q2', 31915),
      ],
    ];
    const out = mapGemGdpYoY(raw, UA_GDP_YOY_METRIC);
    expect(out).toHaveLength(2);
    const q1 = out.find((s) => s.ts === '2022-01-01T00:00:00.000Z');
    expect(q1?.metric).toBe(UA_GDP_YOY_METRIC);
    expect(q1?.value).toBeCloseTo((26123 / 30646 - 1) * 100, 6);
    const q2 = out.find((s) => s.ts === '2022-04-01T00:00:00.000Z');
    expect(q2?.value).toBeCloseTo((20325 / 31915 - 1) * 100, 6); // ≈ −36%
  });
});

describe('createWorldBankGemCollector', () => {
  it('fetches each GEM spec and isolates a single failing series', async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes('CPTOTSAXNZGY')) return [meta, [dp('2022M01', 8.67)]];
      if (url.includes('NYGDPMKTPSAKD') && url.includes('/RUS/'))
        return [meta, [dp('2021Q1', 100), dp('2022Q1', 97)]];
      if (url.includes('NYGDPMKTPSAKD') && url.includes('/UKR/'))
        return { garbage: true }; // UA GDP payload broken → isolated
      throw new Error(`unexpected ${url}`);
    };
    const collector = createWorldBankGemCollector(fetcher);
    expect(collector.name).toBe('worldbank-gem');

    const { snapshots } = await collector.run({} as never);
    const metrics = new Set(snapshots.map((s) => s.metric));
    expect(metrics.has(RU_CPI_YOY_METRIC)).toBe(true);
    expect(metrics.has(RU_GDP_YOY_METRIC)).toBe(true);
    expect(metrics.has(UA_GDP_YOY_METRIC)).toBe(false); // broken series dropped
    expect(snapshots.every((s) => s.source === WORLDBANK_SOURCE)).toBe(true);
  });
});
