import { describe, it, expect } from 'vitest';
import {
  createKielCollector,
  monthToUtcIso,
  AID_COMMITMENTS_METRIC,
  type KielFetchers,
} from '../../../src/lib/sources/kiel';
import type { Env } from '../../../src/lib/types';

// Env is never touched by this collector; an empty cast is sufficient.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub: collector ignores env
const fakeEnv = {} as Env;

function frankfurterPayload(date: string, usdPerEur: number) {
  return { amount: 1, base: 'EUR', date, rates: { USD: usdPerEur } };
}

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

describe('kielCollector.run', () => {
  it('parses, converts USD to EUR via the dated ECB rate, emits UTC ISO', async () => {
    const kielData = [
      { month: '2024-03', amount: 1000, currency: 'USD' },
      { month: '2024-04', amount: 500, currency: 'EUR' },
    ];

    const rateCalls: string[] = [];
    const fetchers: KielFetchers = {
      fetchKiel: async () => kielData,
      fetchRate: async (url) => {
        rateCalls.push(url);
        // 1 EUR = 1.25 USD on the requested date.
        return frankfurterPayload('2024-03-01', 1.25);
      },
    };

    const result = await createKielCollector(fetchers).run(fakeEnv);

    expect(result.snapshots).toHaveLength(2);

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

    // raw_blob round-trips the original record.
    expect(JSON.parse(usdSnap.raw_blob as string)).toEqual(kielData[0]);
  });

  it('coerces numeric strings with separators', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => [
        { month: '2024-01', amount: '2,000', currency: 'USD' },
      ],
      fetchRate: async () => frankfurterPayload('2024-01-01', 2),
    };
    const result = await createKielCollector(fetchers).run(fakeEnv);
    // 2000 USD / 2 = 1000 EUR.
    expect(result.snapshots[0].value).toBeCloseTo(1000, 6);
  });

  it('returns no snapshots for an empty extract', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => [],
      fetchRate: async () => {
        throw new Error('FX should not be called for an empty extract');
      },
    };
    const result = await createKielCollector(fetchers).run(fakeEnv);
    expect(result.snapshots).toEqual([]);
  });

  it('throws on garbage Kiel payload (Zod boundary)', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => ({ totally: 'wrong shape' }),
      fetchRate: async () => frankfurterPayload('2024-01-01', 1),
    };
    await expect(createKielCollector(fetchers).run(fakeEnv)).rejects.toThrow();
  });

  it('throws on unknown source currency', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => [
        { month: '2024-02', amount: 10, currency: 'GBP' },
      ],
      fetchRate: async () => frankfurterPayload('2024-02-01', 1),
    };
    await expect(createKielCollector(fetchers).run(fakeEnv)).rejects.toThrow();
  });

  it('throws when the FX response is missing the requested rate', async () => {
    const fetchers: KielFetchers = {
      fetchKiel: async () => [
        { month: '2024-05', amount: 100, currency: 'USD' },
      ],
      // rates omits USD entirely.
      fetchRate: async () => ({
        amount: 1,
        base: 'EUR',
        date: '2024-05-01',
        rates: {},
      }),
    };
    await expect(createKielCollector(fetchers).run(fakeEnv)).rejects.toThrow(
      /FX rate/
    );
  });
});
