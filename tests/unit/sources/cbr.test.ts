import { describe, it, expect } from 'vitest';
import {
  collectCbr,
  cbrCollector,
  CBR_DAILY_URL,
  SOURCE,
  METRIC_RUB_USD_RATE,
  type JsonFetcher,
} from '../../../src/lib/sources/cbr';

// Realistic https://www.cbr-xml-daily.ru/daily_json.js sample.
// `Date` carries a Moscow +03:00 offset; `Value` is rubles per `Nominal`
// units. USD has Nominal 1; JPY here uses Nominal 100 to prove the
// Value/Nominal division is applied (we only emit USD, but parsing the full
// payload must still succeed).
const sampleResponse = {
  Date: '2026-05-18T11:30:00+03:00',
  PreviousDate: '2026-05-17T11:30:00+03:00',
  PreviousURL: '//www.cbr-xml-daily.ru/archive/2026/05/17/daily_json.js',
  Timestamp: '2026-05-17T23:00:00+03:00',
  Valute: {
    USD: {
      ID: 'R01235',
      NumCode: '840',
      CharCode: 'USD',
      Nominal: 1,
      Name: 'Доллар США',
      Value: 91.2345,
      Previous: 90.9876,
    },
    EUR: {
      ID: 'R01239',
      NumCode: '978',
      CharCode: 'EUR',
      Nominal: 1,
      Name: 'Евро',
      Value: 99.5012,
      Previous: 99.1234,
    },
    JPY: {
      ID: 'R01820',
      NumCode: '392',
      CharCode: 'JPY',
      Nominal: 100,
      Name: 'Японских иен',
      Value: 61.4321,
      Previous: 61.2,
    },
  },
};

const mockFetcher =
  (payload: unknown): JsonFetcher =>
  async (url: string) => {
    expect(url).toBe(CBR_DAILY_URL);
    return payload;
  };

describe('cbr collector', () => {
  it('parses the payload and emits one rub_usd_rate snapshot', async () => {
    const { snapshots, markets } = await collectCbr(
      mockFetcher(sampleResponse)
    );

    expect(markets).toBeUndefined();
    expect(snapshots).toHaveLength(1);

    const [snap] = snapshots;
    expect(snap.metric).toBe(METRIC_RUB_USD_RATE);
    expect(snap.metric).toBe('rub_usd_rate');
    expect(snap.source).toBe(SOURCE);
    expect(snap.source).toBe('cbr');
    expect(snap.confidence).toBe(1);
  });

  it('computes RUB-per-USD as Value / Nominal', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleResponse));
    // USD Nominal is 1, so value === Value.
    expect(snapshots[0].value).toBeCloseTo(91.2345, 6);
  });

  it('applies Nominal in the per-unit computation', async () => {
    // USD quoted per 100 units → RUB-per-USD must be Value / 100.
    const payload = structuredClone(sampleResponse);
    payload.Valute.USD.Nominal = 100;
    payload.Valute.USD.Value = 9123.45;

    const { snapshots } = await collectCbr(mockFetcher(payload));
    expect(snapshots[0].value).toBeCloseTo(91.2345, 6);
  });

  it('normalises the Moscow-offset Date to canonical UTC ISO-8601', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleResponse));
    const { ts } = snapshots[0];

    // +03:00 11:30 → 08:30Z, canonical ...Z form.
    expect(ts).toBe('2026-05-18T08:30:00.000Z');
    expect(ts).toBe(new Date(ts).toISOString());
    expect(ts.endsWith('Z')).toBe(true);
  });

  it('stores the raw USD entry in raw_blob', async () => {
    const { snapshots } = await collectCbr(mockFetcher(sampleResponse));
    const blob = JSON.parse(snapshots[0].raw_blob ?? 'null');
    expect(blob.CharCode).toBe('USD');
    expect(blob.Value).toBe(91.2345);
  });

  it('throws on an unparseable Date', async () => {
    const payload = structuredClone(sampleResponse);
    payload.Date = 'not-a-date';
    await expect(collectCbr(mockFetcher(payload))).rejects.toThrow(
      /unparseable Date/
    );
  });

  it('throws on garbage (non-object) payload', async () => {
    await expect(
      collectCbr(mockFetcher('totally not json shaped'))
    ).rejects.toThrow();
  });

  it('throws on an empty object payload', async () => {
    await expect(collectCbr(mockFetcher({}))).rejects.toThrow();
  });

  it('throws when the USD valute entry is absent', async () => {
    const payload = structuredClone(sampleResponse);
    // Remove USD; schema requires only z.record so this parses, then the
    // collector must reject the missing USD entry explicitly.
    delete (payload.Valute as Record<string, unknown>).USD;
    await expect(collectCbr(mockFetcher(payload))).rejects.toThrow(
      /missing USD/
    );
  });

  it('rejects a non-positive Nominal at the schema boundary', async () => {
    const payload = structuredClone(sampleResponse);
    payload.Valute.USD.Nominal = 0;
    await expect(collectCbr(mockFetcher(payload))).rejects.toThrow();
  });

  it('rejects a non-finite Value at the schema boundary', async () => {
    const payload = structuredClone(sampleResponse);
    // JSON cannot carry NaN/Infinity; an upstream string is the realistic
    // garbage case and must be rejected by z.number().
    (payload.Valute.USD as Record<string, unknown>).Value = '91.2345';
    await expect(collectCbr(mockFetcher(payload))).rejects.toThrow();
  });

  it('exposes a Collector with the stable name', () => {
    expect(cbrCollector.name).toBe(SOURCE);
    expect(typeof cbrCollector.run).toBe('function');
  });
});
