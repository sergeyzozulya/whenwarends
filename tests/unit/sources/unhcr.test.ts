import { describe, it, expect } from 'vitest';
import {
  createUnhcrCollector,
  mapPopulation,
  populationUrl,
  yearEndIsoUtc,
  UNHCR_SOURCE,
  REFUGEES_METRIC,
  IDPS_METRIC,
  type JsonFetcher,
} from '../../../src/lib/sources/unhcr';
import { UnhcrPopulationResponseSchema } from '../../../src/lib/sources/unhcr.schema';

// Realistic Refugee Data Finder rows: refugees spread over countries of asylum,
// IDPs attributed only to the origin (coa=UKR). Counts arrive as numbers AND
// strings ("0", "-") — the schema coerces, treating non-numeric as 0.
const popResponse = {
  page: 1,
  maxPages: 1,
  total: 4,
  items: [
    { year: 2022, coo: 'UKR', coa: 'POL', refugees: 1500000, idps: '0' },
    { year: 2022, coo: 'UKR', coa: 'UKR', refugees: '0', idps: 5900000 },
    { year: 2022, coo: 'UKR', coa: 'DEU', refugees: 1000000, idps: '-' },
    { year: 2023, coo: 'UKR', coa: 'POL', refugees: 1600000, idps: 0 },
    { year: 2023, coo: 'UKR', coa: 'UKR', refugees: 0, idps: 3700000 },
  ],
};

describe('UnhcrPopulationResponseSchema', () => {
  it('coerces number|string|"-" count cells', () => {
    const parsed = UnhcrPopulationResponseSchema.parse(popResponse);
    expect(parsed.items[1].idps).toBe(5900000);
    expect(parsed.items[2].idps).toBe(0); // "-" → 0
    expect(parsed.items[0].refugees).toBe(1500000);
  });
  it('rejects a payload without items', () => {
    expect(() => UnhcrPopulationResponseSchema.parse({})).toThrow();
  });
});

describe('populationUrl', () => {
  it('fixes origin to Ukraine and spans war-start → the given year', () => {
    const url = populationUrl(2026);
    expect(url).toContain('coo=UKR');
    expect(url).toContain('coa_all=true');
    expect(url).toContain('yearFrom=2022');
    expect(url).toContain('yearTo=2026');
  });
});

describe('yearEndIsoUtc', () => {
  it('pins a year to its 31 Dec end-of-year stock instant', () => {
    expect(yearEndIsoUtc(2022)).toBe('2022-12-31T00:00:00.000Z');
  });
});

describe('mapPopulation', () => {
  it('sums refugees + IDPs per year into year-end snapshots', () => {
    const snaps = mapPopulation(popResponse);
    const ref2022 = snaps.find((s) => s.metric === REFUGEES_METRIC && s.ts === '2022-12-31T00:00:00.000Z');
    const idp2022 = snaps.find((s) => s.metric === IDPS_METRIC && s.ts === '2022-12-31T00:00:00.000Z');
    expect(ref2022?.value).toBe(2500000); // 1.5M (POL) + 1.0M (DEU)
    expect(idp2022?.value).toBe(5900000); // only the coa=UKR row
    expect(snaps.every((s) => s.source === UNHCR_SOURCE)).toBe(true);
    const idp2023 = snaps.find((s) => s.metric === IDPS_METRIC && s.ts === '2023-12-31T00:00:00.000Z');
    expect(idp2023?.value).toBe(3700000);
  });

  it('skips a metric whose yearly total is zero (never fabricated)', () => {
    const onlyRefugees = { items: [{ year: 2024, coo: 'UKR', coa: 'POL', refugees: 100, idps: '0' }] };
    const snaps = mapPopulation(onlyRefugees);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].metric).toBe(REFUGEES_METRIC);
  });

  it('throws on garbage input (Zod boundary)', () => {
    expect(() => mapPopulation(null)).toThrow();
  });
});

describe('createUnhcrCollector', () => {
  it('queries through the current year and emits both series', async () => {
    const seen: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      seen.push(url);
      return popResponse;
    };
    const now = () => new Date('2026-05-22T00:00:00Z');
    const result = await createUnhcrCollector(fetcher, now).run({} as never);
    expect(seen[0]).toContain('yearTo=2026');
    const metrics = new Set(result.snapshots.map((s) => s.metric));
    expect(metrics).toEqual(new Set([REFUGEES_METRIC, IDPS_METRIC]));
  });

  it('throws when no rows parse', async () => {
    const collector = createUnhcrCollector(async () => ({ items: [] }));
    await expect(collector.run({} as never)).rejects.toThrow(/no parseable/);
  });
});
