import { describe, it, expect } from 'vitest';
import {
  createCreaCollector,
  mapCounter,
  dataDateToIsoUtc,
  counterUrl,
  CREA_SOURCE,
  REVENUE_CUMULATIVE_METRIC,
  type JsonFetcher,
} from '../../../src/lib/sources/crea';
import { CreaCounterResponseSchema } from '../../../src/lib/sources/crea.schema';

// Realistic counter payload: aggregate_by=date&cumulate=true yields one grand-
// total row per day (no commodity/destination breakdown), value_eur cumulative.
const counterResponse = {
  data: [
    { date: '2022-02-24T00:00:00', value_eur: 1.0e9, value_tonne: 1, value_usd: 1.1e9 },
    { date: '2022-03-01T00:00:00', value_eur: 8.0e9, value_tonne: 9, value_usd: 9.0e9 },
    // a null day → schema tolerates it, collector skips it (never fabricated)
    { date: '2022-03-02T00:00:00', value_eur: null, value_tonne: 0, value_usd: 0 },
    { date: '2026-05-21T00:00:00', value_eur: 1.071e12, value_tonne: 1, value_usd: 1.2e12 },
  ],
};

describe('CreaCounterResponseSchema', () => {
  it('parses the data array and tolerates extra columns', () => {
    const parsed = CreaCounterResponseSchema.parse(counterResponse);
    expect(parsed.data).toHaveLength(4);
  });
  it('rejects a payload with no data array', () => {
    expect(() => CreaCounterResponseSchema.parse({})).toThrow();
  });
});

describe('counterUrl', () => {
  it('requests a cumulative daily series from the invasion date', () => {
    const url = counterUrl();
    expect(url).toContain('aggregate_by=date');
    expect(url).toContain('cumulate=true');
    expect(url).toContain('date_from=2022-02-24');
    expect(url).toContain('pricing_scenario=default');
  });
});

describe('dataDateToIsoUtc', () => {
  it('takes the date part of an instant and pins to midnight Z', () => {
    expect(dataDateToIsoUtc('2026-05-21T00:00:00')).toBe('2026-05-21T00:00:00.000Z');
  });
  it('returns undefined for garbage', () => {
    expect(dataDateToIsoUtc('nope')).toBeUndefined();
  });
});

describe('mapCounter', () => {
  it('emits one cumulative snapshot per valid day, sorted, skipping bad rows', () => {
    const snaps = mapCounter(counterResponse);
    expect(snaps).toHaveLength(3); // the NaN row is dropped
    expect(snaps.every((s) => s.metric === REVENUE_CUMULATIVE_METRIC)).toBe(true);
    expect(snaps.every((s) => s.source === CREA_SOURCE)).toBe(true);
    expect(snaps[0].ts).toBe('2022-02-24T00:00:00.000Z');
    expect(snaps[0].value).toBe(1.0e9);
    const latest = snaps[snaps.length - 1];
    expect(latest.ts).toBe('2026-05-21T00:00:00.000Z');
    expect(latest.value).toBe(1.071e12); // reconciles to CREA's headline
  });

  it('throws on garbage input (Zod boundary)', () => {
    expect(() => mapCounter(null)).toThrow();
  });
});

describe('createCreaCollector', () => {
  it('fetches the counter series and emits the full cumulative line', async () => {
    const seen: string[] = [];
    const fetcher: JsonFetcher = async (url) => {
      seen.push(url);
      return counterResponse;
    };
    const result = await createCreaCollector(fetcher).run({} as never);
    expect(seen[0]).toContain('/v0/counter');
    expect(result.snapshots.length).toBe(3);
  });

  it('throws when the series is empty', async () => {
    const collector = createCreaCollector(async () => ({ data: [] }));
    await expect(collector.run({} as never)).rejects.toThrow(/no parseable/);
  });
});
