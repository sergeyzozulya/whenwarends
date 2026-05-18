import { describe, it, expect } from 'vitest';
import {
  createKielCollector,
  monthToUtcIso,
  AID_COMMITMENTS_METRIC,
  KielSourceError,
  KIEL_DEFAULT_URL,
  type KielFetchers,
} from '../../../src/lib/sources/kiel';
import { parseCsv, csvToCommitmentRows } from '../../../src/lib/sources/kiel.schema';
import type { Env } from '../../../src/lib/types';

// Env carries operator config (KIEL_DATASET_URL) plus platform bindings; a
// cast is sufficient since the collector only reads that one optional key.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub: collector reads only KIEL_DATASET_URL
const envWithUrl = { KIEL_DATASET_URL: 'https://example.test/kiel.csv' } as any as Env;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub: no override → default URL
const envNoUrl = {} as any as Env;

function frankfurterPayload(date: string, usdPerEur: number) {
  return { amount: 1, base: 'EUR', date, rates: { USD: usdPerEur } };
}

const HEADER = 'month,amount,currency';

describe('monthToUtcIso', () => {
  it('anchors a YYYY-MM month at the first UTC instant', () => {
    expect(monthToUtcIso('2024-03')).toBe('2024-03-01T00:00:00.000Z');
  });

  it('accepts a full ISO date and keeps year+month', () => {
    expect(monthToUtcIso('2023-11-17T12:34:56Z')).toBe(
      '2023-11-01T00:00:00.000Z'
    );
  });

  it('rejects garbage and out-of-range months', () => {
    expect(() => monthToUtcIso('not-a-date')).toThrow();
    expect(() => monthToUtcIso('2024-13')).toThrow();
  });
});

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas, escaped quotes and CRLF', () => {
    const text = 'a,b\r\n"x,y","he said ""hi"""\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"'],
    ]);
  });

  it('drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('csvToCommitmentRows', () => {
  it('maps columns by tolerant header aliases regardless of order', () => {
    const grid = parseCsv('Currency,Value,Date\nUSD,1000,2024-03\n');
    expect(csvToCommitmentRows(grid)).toEqual([
      { month: '2024-03', amount: '1000', currency: 'USD' },
    ]);
  });

  it('throws when required columns are absent', () => {
    expect(() => csvToCommitmentRows(parseCsv('foo,bar\n1,2\n'))).toThrow(
      /missing required columns/
    );
  });

  it('skips ragged/short trailing note rows', () => {
    const grid = parseCsv(`${HEADER}\n2024-03,1000,EUR\nNote: provisional\n`);
    expect(csvToCommitmentRows(grid)).toEqual([
      { month: '2024-03', amount: '1000', currency: 'EUR' },
    ]);
  });
});

describe('kielCollector.run', () => {
  it('parses CSV, converts USD to EUR via the dated ECB rate, emits UTC ISO', async () => {
    const csv = `${HEADER}\n2024-03,1000,USD\n2024-04,500,EUR\n`;

    const rateCalls: string[] = [];
    const kielUrls: string[] = [];
    const fetchers: KielFetchers = {
      fetchKiel: async (url) => {
        kielUrls.push(url);
        return csv;
      },
      fetchRate: async (url) => {
        rateCalls.push(url);
        // 1 EUR = 1.25 USD on the requested date.
        return frankfurterPayload('2024-03-01', 1.25);
      },
    };

    const result = await createKielCollector(fetchers).run(envWithUrl);

    expect(result.snapshots).toHaveLength(2);
    expect(kielUrls).toEqual(['https://example.test/kiel.csv']);

    const [usdSnap, eurSnap] = result.snapshots;

    // USD record: 1000 USD / 1.25 = 800 EUR.
    expect(usdSnap.metric).toBe(AID_COMMITMENTS_METRIC);
    expect(usdSnap.source).toBe('kiel');
    expect(usdSnap.ts).toBe('2024-03-01T00:00:00.000Z');
    expect(usdSnap.value).toBeCloseTo(800, 6);
    expect(usdSnap.confidence).toBe(1);

    // EUR record passes through untouched and triggers no FX request.
    expect(eurSnap.value).toBe(500);
    expect(eurSnap.ts).toBe('2024-04-01T00:00:00.000Z');

    // Only the USD month asked Frankfurter, dated at the month start.
    expect(rateCalls).toHaveLength(1);
    expect(rateCalls[0]).toContain('/2024-03-01?');
    expect(rateCalls[0]).toContain('from=EUR&to=USD');

    // raw_blob round-trips the parsed (typed) record.
    expect(JSON.parse(usdSnap.raw_blob as string)).toEqual({
      month: '2024-03',
      amount: 1000,
      currency: 'USD',
    });
  });

  it('falls back to the default Kiel URL when no env override is set', async () => {
    const kielUrls: string[] = [];
    const fetchers: KielFetchers = {
      fetchKiel: async (url) => {
        kielUrls.push(url);
        return `${HEADER}\n2024-01,10,EUR\n`;
      },
      fetchRate: async () => {
        throw new Error('FX must not be called for an EUR-only extract');
      },
    };
    await createKielCollector(fetchers).run(envNoUrl);
    expect(kielUrls).toEqual([KIEL_DEFAULT_URL]);
  });

  it('coerces numeric strings with separators', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => `${HEADER}\n2024-01,"2,000",USD\n`,
      fetchRate: async () => frankfurterPayload('2024-01-01', 2),
    };
    const result = await createKielCollector(fetchers).run(envWithUrl);
    // 2000 USD / 2 = 1000 EUR.
    expect(result.snapshots[0].value).toBeCloseTo(1000, 6);
  });

  it('throws a typed error when the source is unreachable', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => {
        throw new Error('fetch failed');
      },
      fetchRate: async () => frankfurterPayload('2024-01-01', 1),
    };
    await expect(
      createKielCollector(fetchers).run(envWithUrl)
    ).rejects.toBeInstanceOf(KielSourceError);
  });

  it('throws a typed error when the source is not parseable CSV (e.g. HTML/XLSX)', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => '<html><body>Not Found</body></html>',
      fetchRate: async () => frankfurterPayload('2024-01-01', 1),
    };
    await expect(
      createKielCollector(fetchers).run(envWithUrl)
    ).rejects.toThrow(KielSourceError);
  });

  it('throws when the CSV has a header but no data rows (no fabrication)', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => `${HEADER}\n`,
      fetchRate: async () => {
        throw new Error('FX should not be called for an empty extract');
      },
    };
    await expect(
      createKielCollector(fetchers).run(envWithUrl)
    ).rejects.toThrow();
  });

  it('throws on unknown source currency (Zod boundary)', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => `${HEADER}\n2024-02,10,GBP\n`,
      fetchRate: async () => frankfurterPayload('2024-02-01', 1),
    };
    await expect(
      createKielCollector(fetchers).run(envWithUrl)
    ).rejects.toThrow();
  });

  it('throws when the FX response is missing the requested rate', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => `${HEADER}\n2024-05,100,USD\n`,
      // rates omits USD entirely.
      fetchRate: async () => ({
        amount: 1,
        base: 'EUR',
        date: '2024-05-01',
        rates: {},
      }),
    };
    await expect(
      createKielCollector(fetchers).run(envWithUrl)
    ).rejects.toThrow(/FX rate/);
  });
});
