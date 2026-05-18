import { describe, it, expect } from 'vitest';
import {
  gdeltCollector,
  normalizeGdeltDate,
  type JsonFetcher,
} from '../../../src/lib/sources/gdelt';
import { GdeltTimelineResponseSchema } from '../../../src/lib/sources/gdelt.schema';

// Realistic GDELT DOC 2.0 timeline JSON. `timelinevol` and `timelinetone`
// share the same envelope; only the series name and value scale differ.
const volJson = {
  timeline: [
    {
      series: 'Volume Intensity',
      data: [
        { date: '20260515000000', value: 4.21 },
        { date: '20260516000000', value: 4.87 },
        { date: '20260517T120000Z', value: 5.03 },
      ],
    },
  ],
};

const toneJson = {
  timeline: [
    {
      series: 'Average Tone',
      data: [
        { date: '20260515000000', value: -6.12 },
        { date: '2026-05-16T00:00:00Z', value: -5.74 },
      ],
    },
  ],
};

/** Build an injectable fetcher that returns vol/tone JSON by URL mode. */
function makeFetcher(vol: unknown, tone: unknown): JsonFetcher {
  return (url: string) => {
    if (url.includes('mode=timelinevol')) return Promise.resolve(vol);
    if (url.includes('mode=timelinetone')) return Promise.resolve(tone);
    throw new Error(`unexpected url: ${url}`);
  };
}

describe('normalizeGdeltDate', () => {
  it('parses compact YYYYMMDDHHMMSS as UTC ISO-8601', () => {
    expect(normalizeGdeltDate('20260517000000')).toBe(
      '2026-05-17T00:00:00.000Z'
    );
  });

  it('parses YYYYMMDDTHHMMSSZ', () => {
    expect(normalizeGdeltDate('20260517T120000Z')).toBe(
      '2026-05-17T12:00:00.000Z'
    );
  });

  it('passes through already-ISO input', () => {
    expect(normalizeGdeltDate('2026-05-16T00:00:00Z')).toBe(
      '2026-05-16T00:00:00.000Z'
    );
  });

  it('returns null for garbage', () => {
    expect(normalizeGdeltDate('not-a-date')).toBeNull();
    expect(normalizeGdeltDate('')).toBeNull();
    expect(normalizeGdeltDate('20261399000000')).toBeNull();
  });
});

describe('GdeltTimelineResponseSchema', () => {
  it('accepts a valid timeline envelope', () => {
    expect(() => GdeltTimelineResponseSchema.parse(volJson)).not.toThrow();
  });

  it('rejects garbage', () => {
    expect(() => GdeltTimelineResponseSchema.parse({})).toThrow();
    expect(() =>
      GdeltTimelineResponseSchema.parse({ timeline: [{ series: 'x' }] })
    ).toThrow();
    expect(() =>
      GdeltTimelineResponseSchema.parse({
        timeline: [{ series: 'x', data: [{ date: '1', value: 'nope' }] }],
      })
    ).toThrow();
  });
});

describe('gdeltCollector', () => {
  it('has the stable source name', () => {
    expect(gdeltCollector.name).toBe('gdelt');
  });

  it('parses and maps both metrics with ISO-8601 UTC timestamps', async () => {
    const result = await gdeltCollector.runWith(makeFetcher(volJson, toneJson));

    expect(result.markets).toBeUndefined();
    expect(result.snapshots).toHaveLength(5); // 3 vol + 2 tone

    const intensity = result.snapshots.filter(
      (s) => s.metric === 'conflict_intensity'
    );
    const tone = result.snapshots.filter((s) => s.metric === 'conflict_tone');
    expect(intensity).toHaveLength(3);
    expect(tone).toHaveLength(2);

    for (const s of result.snapshots) {
      expect(s.source).toBe('gdelt');
      expect(typeof s.value).toBe('number');
      expect(s.confidence).toBe(0.9);
      // Every ts must be a valid ISO-8601 UTC instant.
      expect(s.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(s.ts).toISOString()).toBe(s.ts);
    }

    expect(intensity.map((s) => s.value)).toEqual([4.21, 4.87, 5.03]);
    expect(intensity[2].ts).toBe('2026-05-17T12:00:00.000Z');
    expect(tone.map((s) => s.value)).toEqual([-6.12, -5.74]);
    expect(tone[1].ts).toBe('2026-05-16T00:00:00.000Z');
  });

  it('handles empty timelines', async () => {
    const empty = { timeline: [] };
    const result = await gdeltCollector.runWith(makeFetcher(empty, empty));
    expect(result.snapshots).toEqual([]);
  });

  it('skips points with un-parseable dates or non-finite values', async () => {
    const dirty = {
      timeline: [
        {
          series: 'Volume Intensity',
          data: [
            { date: 'garbage', value: 1.1 },
            { date: '20260517000000', value: 2.2 },
          ],
        },
      ],
    };
    const result = await gdeltCollector.runWith(
      makeFetcher(dirty, { timeline: [] })
    );
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].value).toBe(2.2);
    expect(result.snapshots[0].metric).toBe('conflict_intensity');
  });

  it('throws on schema-invalid (garbage) responses', async () => {
    await expect(
      gdeltCollector.runWith(makeFetcher({ bogus: true }, { timeline: [] }))
    ).rejects.toThrow();
  });
});
