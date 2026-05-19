import { describe, it, expect } from 'vitest';
import type { Env } from '../../../src/lib/types';
import {
  collectNbuCpiHistory,
  selectHeadline,
  nbuCpiUrl,
  nbuCpiDtToIsoUtc,
  nbuCpiCollector,
  UA_CPI_YOY_METRIC,
} from '../../../src/lib/sources/nbuCpi';
import { NbuCpiResponseSchema } from '../../../src/lib/sources/nbuCpi.schema';

// One realistic month: the unique national headline row, plus the kinds of
// near-twins that must NOT be picked — a region row (ku set), a sub-aggregate
// (mcrk110 set), the month-on-month measure (tzep PCPM_), core inflation and
// PPI datasets (id_api differs). Verified against Ukraine's official series.
function month(dt: string, headlineValue: number | null) {
  const base = {
    dt,
    txten: 'Consumer price indices ',
    freq: 'M',
    leveli: '1',
    parent: null,
  };
  return [
    // national headline CPI, % y/y — the ONLY row we want
    { ...base, id_api: 'prices_price_cpi_', mcrd081: 'Total', ku: null, mcrk110: 'NULL', tzep: 'PCCM_', value: headlineValue },
    // same row but month-on-month — different measure
    { ...base, id_api: 'prices_price_cpi_', mcrd081: 'Total', ku: null, mcrk110: 'NULL', tzep: 'PCPM_', value: 1.3 },
    // a region (ku set) — must not be mistaken for the national figure
    { ...base, id_api: 'prices_price_cpi_', mcrd081: 'Total', ku: '7', mcrk110: 'NULL', tzep: 'PCCM_', value: 99.9 },
    // a COICOP sub-division (mcrd081 not Total)
    { ...base, id_api: 'prices_price_cpi_', mcrd081: '07', ku: null, mcrk110: 'NULL', tzep: 'PCCM_', value: 42 },
    // a sub-aggregate (mcrk110 set)
    { ...base, id_api: 'prices_price_cpi_', mcrd081: 'Total', ku: null, mcrk110: 'C', tzep: 'PCCM_', value: 12 },
    // core inflation + PPI datasets share the endpoint
    { ...base, id_api: 'prices_price_ci_', mcrd081: 'Total', ku: null, mcrk110: 'NULL', tzep: 'PCCM_', value: 3.3, txten: 'Core inflation' },
    { ...base, id_api: 'prices_price_ppi_', mcrd081: 'Total', ku: null, mcrk110: 'NULL', tzep: 'PCCM_', value: 7.7, txten: 'Industrial Producer Price Indices' },
  ];
}

const fakeEnv = {} as Env;

describe('nbuCpiDtToIsoUtc', () => {
  it('maps YYYYMMDD to ISO-8601 UTC midnight', () => {
    expect(nbuCpiDtToIsoUtc('20231201')).toBe('2023-12-01T00:00:00.000Z');
    expect(nbuCpiDtToIsoUtc(' 20220101 ')).toBe('2022-01-01T00:00:00.000Z');
  });
  it('returns null for malformed / impossible dates', () => {
    expect(nbuCpiDtToIsoUtc('2023-12-01')).toBeNull();
    expect(nbuCpiDtToIsoUtc('20230231')).toBeNull();
    expect(nbuCpiDtToIsoUtc('garbage')).toBeNull();
  });
});

describe('nbuCpiUrl', () => {
  it('builds the documented monthly inflation endpoint', () => {
    const u = nbuCpiUrl(Date.UTC(2024, 2, 1));
    expect(u).toBe(
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/inflation?json&period=m&date=202403'
    );
  });
});

describe('selectHeadline', () => {
  it('picks exactly the national headline CPI y/y row', () => {
    const rows = NbuCpiResponseSchema.parse(month('20231201', 5.1));
    const hit = selectHeadline(rows);
    expect(hit?.value).toBe(5.1);
    expect(hit?.tzep).toBe('PCCM_');
    expect(hit?.mcrd081).toBe('Total');
    expect(hit?.ku).toBeNull();
  });

  it('returns null when the headline row is absent (never a sibling)', () => {
    const rows = NbuCpiResponseSchema.parse(
      month('20231201', 5.1).filter(
        (r) => !(r.mcrd081 === 'Total' && r.ku === null && r.mcrk110 === 'NULL' && r.tzep === 'PCCM_' && r.id_api === 'prices_price_cpi_')
      )
    );
    expect(selectHeadline(rows)).toBeNull();
  });

  it('returns null when the headline value is null (no fabrication)', () => {
    const rows = NbuCpiResponseSchema.parse(month('20231201', null));
    expect(selectHeadline(rows)).toBeNull();
  });
});

describe('collectNbuCpiHistory', () => {
  const byMonth =
    (val = 7.5) =>
    async (url: string): Promise<unknown> => {
      const m = /date=(\d{4})(\d{2})/.exec(url);
      if (!m) return [];
      const [, y, mo] = m;
      return month(`${y}${mo}01`, val);
    };

  it('emits one ascending monthly headline snapshot per month', async () => {
    const { snapshots } = await collectNbuCpiHistory(
      Date.UTC(2022, 0, 1),
      Date.UTC(2022, 2, 1),
      byMonth(8.7)
    );
    expect(snapshots).toHaveLength(3);
    expect(snapshots.every((s) => s.metric === UA_CPI_YOY_METRIC)).toBe(true);
    expect(snapshots.every((s) => s.source === 'nbu')).toBe(true);
    expect(snapshots.every((s) => s.value === 8.7)).toBe(true);
    const ts = snapshots.map((s) => s.ts);
    expect([...ts]).toEqual([...ts].sort());
    expect(ts[0]).toBe('2022-01-01T00:00:00.000Z');
  });

  it('skips a month with no headline row, never fabricating', async () => {
    const fetcher = async (url: string): Promise<unknown> =>
      url.includes('date=202202') ? [] : byMonth()(url);
    const { snapshots } = await collectNbuCpiHistory(
      Date.UTC(2022, 0, 1),
      Date.UTC(2022, 2, 1),
      fetcher
    );
    expect(snapshots).toHaveLength(2);
  });

  it('throws only when every month failed', async () => {
    await expect(
      collectNbuCpiHistory(Date.UTC(2022, 0, 1), Date.UTC(2022, 1, 1), async () => {
        throw new Error('network');
      })
    ).rejects.toThrow(/every monthly request failed/);
  });

  it('collector is failure-isolated by name', () => {
    expect(nbuCpiCollector.name).toBe('nbu-cpi');
    expect(typeof nbuCpiCollector.run).toBe('function');
    void fakeEnv;
  });
});
