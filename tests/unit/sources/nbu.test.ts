import { describe, it, expect } from 'vitest';
import type { Env } from '../../../src/lib/types';
import {
  createNbuCollector,
  nbuDateToIsoUtc,
  NBU_UAH_USD_METRIC,
  NBU_EXCHANGE_URL,
} from '../../../src/lib/sources/nbu';

// The collector never touches env in this code path; an empty cast is safe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub: collector ignores env
const fakeEnv = {} as Env;

// Realistic slice of the NBU statdirectory exchange JSON response.
const NBU_SAMPLE = [
  { r030: 36, txt: 'Австралійський долар', rate: 27.1234, cc: 'AUD', exchangedate: '16.05.2026' },
  { r030: 978, txt: 'Євро', rate: 46.1187, cc: 'EUR', exchangedate: '16.05.2026' },
  { r030: 840, txt: 'Долар США', rate: 41.5023, cc: 'USD', exchangedate: '16.05.2026' },
  { r030: 826, txt: 'Фунт стерлінгів', rate: 54.882, cc: 'GBP', exchangedate: '16.05.2026' },
];

function fetcherReturning(payload: unknown) {
  return async (url: string): Promise<unknown> => {
    expect(url).toBe(NBU_EXCHANGE_URL);
    return payload;
  };
}

describe('nbuDateToIsoUtc', () => {
  it('converts dd.mm.yyyy to ISO-8601 UTC midnight', () => {
    expect(nbuDateToIsoUtc('16.05.2026')).toBe('2026-05-16T00:00:00.000Z');
    expect(nbuDateToIsoUtc('01.01.2024')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('tolerates surrounding whitespace', () => {
    expect(nbuDateToIsoUtc('  16.05.2026 ')).toBe('2026-05-16T00:00:00.000Z');
  });

  it('throws on a malformed date string', () => {
    expect(() => nbuDateToIsoUtc('2026-05-16')).toThrow(/unexpected NBU exchangedate/);
    expect(() => nbuDateToIsoUtc('garbage')).toThrow(/unexpected NBU exchangedate/);
  });

  it('throws on an impossible calendar date', () => {
    expect(() => nbuDateToIsoUtc('31.02.2026')).toThrow(/invalid NBU exchangedate/);
  });
});

describe('nbuCollector', () => {
  it('parses, selects USD, and maps the rate to a snapshot', async () => {
    const collector = createNbuCollector(fetcherReturning(NBU_SAMPLE));
    const result = await collector.run(fakeEnv);

    expect(collector.name).toBe('nbu');
    expect(result.snapshots).toHaveLength(1);

    const snap = result.snapshots[0];
    expect(snap.metric).toBe(NBU_UAH_USD_METRIC);
    expect(snap.metric).toBe('uah_usd_rate');
    expect(snap.source).toBe('nbu');
    expect(snap.value).toBe(41.5023); // UAH per USD, from the USD row only
    expect(snap.ts).toBe('2026-05-16T00:00:00.000Z');
    expect(snap.confidence).toBe(1);
    expect(typeof snap.raw_blob).toBe('string');
    expect(JSON.parse(snap.raw_blob as string)).toMatchObject({ cc: 'USD', rate: 41.5023 });
  });

  it('emits no markets', async () => {
    const collector = createNbuCollector(fetcherReturning(NBU_SAMPLE));
    const result = await collector.run(fakeEnv);
    expect(result.markets).toBeUndefined();
  });

  it('selects USD case-insensitively', async () => {
    const payload = [
      { r030: 840, txt: 'Долар США', rate: 40.0, cc: 'usd', exchangedate: '01.03.2026' },
    ];
    const result = await createNbuCollector(fetcherReturning(payload)).run(fakeEnv);
    expect(result.snapshots[0].value).toBe(40.0);
    expect(result.snapshots[0].ts).toBe('2026-03-01T00:00:00.000Z');
  });

  it('throws when USD is absent from the response', async () => {
    const payload = [
      { r030: 978, txt: 'Євро', rate: 46.1, cc: 'EUR', exchangedate: '16.05.2026' },
    ];
    await expect(
      createNbuCollector(fetcherReturning(payload)).run(fakeEnv)
    ).rejects.toThrow(/did not include a USD rate/);
  });

  it('throws on an empty array (no USD)', async () => {
    await expect(
      createNbuCollector(fetcherReturning([])).run(fakeEnv)
    ).rejects.toThrow(/did not include a USD rate/);
  });

  it('throws on a non-positive USD rate', async () => {
    const payload = [
      { r030: 840, txt: 'Долар США', rate: 0, cc: 'USD', exchangedate: '16.05.2026' },
    ];
    await expect(
      createNbuCollector(fetcherReturning(payload)).run(fakeEnv)
    ).rejects.toThrow(/not a positive number/);
  });

  it('rejects garbage / non-array payloads via Zod', async () => {
    await expect(
      createNbuCollector(fetcherReturning({ not: 'an array' })).run(fakeEnv)
    ).rejects.toThrow();

    await expect(
      createNbuCollector(fetcherReturning('totally not json-shaped')).run(fakeEnv)
    ).rejects.toThrow();

    await expect(
      createNbuCollector(fetcherReturning(null)).run(fakeEnv)
    ).rejects.toThrow();
  });

  it('rejects rows with the wrong field types via Zod', async () => {
    const payload = [
      { r030: 840, txt: 'Долар США', rate: '41.50', cc: 'USD', exchangedate: '16.05.2026' },
    ];
    await expect(
      createNbuCollector(fetcherReturning(payload)).run(fakeEnv)
    ).rejects.toThrow();
  });
});
