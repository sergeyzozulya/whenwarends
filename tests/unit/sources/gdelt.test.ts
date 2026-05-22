import { describe, it, expect } from 'vitest';
import {
  gdeltCollector,
  collectGdeltHistory,
  normalizeGdeltDate,
  GdeltResponseError,
  makeGdeltFetcher,
  createGdeltPacer,
  describeFetchError,
  type JsonFetcher,
  type ResponseFetcher,
  type GdeltPacer,
} from '../../../src/lib/sources/gdelt';
import { GdeltTimelineResponseSchema } from '../../../src/lib/sources/gdelt.schema';

// Real GDELT DOC 2.0 timeline JSON shape (captured live 2026-05-18). The API
// echoes `query_details` metadata and emits dates as `YYYYMMDDTHHMMSSZ` at
// 15-minute resolution. `timelinevol` and `timelinetone` share the envelope;
// only the series name and value scale differ. We keep a couple of legacy
// date variants here to also exercise normalizeGdeltDate's tolerance.
const volJson = {
  query_details: {
    title:
      '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng',
    date_resolution: '15m',
  },
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
  query_details: {
    title:
      '(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng',
    date_resolution: '15m',
  },
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

  it('accepts the real envelope including query_details metadata', async () => {
    const result = await gdeltCollector.runWith(makeFetcher(volJson, toneJson));
    // 3 vol + 2 tone, query_details ignored but not rejected.
    expect(result.snapshots).toHaveLength(5);
  });

  it('percent-encodes the query (spaces => %20, never +)', async () => {
    const urls: string[] = [];
    const fetcher: JsonFetcher = (url: string) => {
      urls.push(url);
      return Promise.resolve({ timeline: [] });
    };
    await gdeltCollector.runWith(fetcher);

    // Recurring path: one recent window × 2 modes — exactly 2 requests.
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      // `+`-for-space encoding is what broke the live call against GDELT.
      expect(url).not.toContain('+');
      expect(url).toContain('%20');
      expect(url).toContain('format=json');
      // Explicit date range replaces the old timespan=12m history cap.
      expect(url).toContain('startdatetime=');
      expect(url).toContain('enddatetime=');
      expect(url).not.toContain('timespan=');
      expect(url.startsWith('https://api.gdeltproject.org/api/v2/doc/doc?')).toBe(
        true
      );
    }
    expect(urls.some((u) => u.includes('mode=timelinevol'))).toBe(true);
    expect(urls.some((u) => u.includes('mode=timelinetone'))).toBe(true);
  });

  it('surfaces a typed GdeltResponseError when the fetcher rejects (e.g. 429 text)', async () => {
    const failing: JsonFetcher = () =>
      Promise.reject(
        new GdeltResponseError(
          'GDELT returned non-JSON (content-type ""): Please limit requests to one every 5 seconds'
        )
      );
    await expect(gdeltCollector.runWith(failing)).rejects.toBeInstanceOf(
      GdeltResponseError
    );
  });
});

describe('collectGdeltHistory (one-time backfill)', () => {
  it('walks yearly windows back to 2022 and dedupes repeated points', async () => {
    const urls: string[] = [];
    const fetcher: JsonFetcher = (url) => {
      urls.push(url);
      return Promise.resolve(url.includes('timelinevol') ? volJson : toneJson);
    };
    const { snapshots } = await collectGdeltHistory(fetcher);

    // ≥ (2022..now) years × 2 modes; always even; reaches the war run-up.
    expect(urls.length).toBeGreaterThanOrEqual(8);
    expect(urls.length % 2).toBe(0);
    expect(urls.some((u) => u.includes('startdatetime=2022'))).toBe(true);
    // Same stub per window → dedupe to the distinct points (3 vol + 2 tone).
    expect(
      snapshots.filter((s) => s.metric === 'conflict_intensity')
    ).toHaveLength(3);
    expect(
      snapshots.filter((s) => s.metric === 'conflict_tone')
    ).toHaveLength(2);
  });

  it('is resilient: a failing window is skipped, survivors kept', async () => {
    let n = 0;
    const flaky: JsonFetcher = (url) => {
      n += 1;
      if (n % 3 === 0) return Promise.reject(new Error('429-ish'));
      return Promise.resolve(url.includes('timelinevol') ? volJson : toneJson);
    };
    const { snapshots } = await collectGdeltHistory(flaky);
    expect(snapshots.length).toBeGreaterThan(0); // didn't abort on a skip
  });

  it('throws only when every window fails', async () => {
    const allDead: JsonFetcher = () => Promise.reject(new Error('down'));
    await expect(collectGdeltHistory(allDead)).rejects.toBeInstanceOf(
      GdeltResponseError
    );
  });
});

describe('describeFetchError', () => {
  it('unwraps Node’s opaque "fetch failed" cause chain (with code)', () => {
    const cause = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeFetchError(err)).toBe(
      'fetch failed ← other side closed (UND_ERR_SOCKET)'
    );
  });

  it('handles a plain error and a non-error', () => {
    expect(describeFetchError(new Error('boom'))).toBe('boom');
    expect(describeFetchError('nope')).toBe('nope');
  });
});

describe('makeGdeltFetcher (retry budget)', () => {
  // No-op pacer so the retry-branch tests run instantly; spacing is verified
  // separately in the createGdeltPacer block below.
  const noPacer: GdeltPacer = { acquire: () => Promise.resolve() };
  const jsonRes = (obj: unknown): Response =>
    new Response(JSON.stringify(obj), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const textRes = (text: string, status = 200): Response =>
    new Response(text, { status, headers: { 'content-type': 'text/plain' } });
  const transportError = (): Error =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    });

  it('retries a transport failure ("fetch failed") and then succeeds', async () => {
    let calls = 0;
    const fetchImpl: ResponseFetcher = () => {
      calls += 1;
      return calls < 3
        ? Promise.reject(transportError())
        : Promise.resolve(jsonRes(volJson));
    };
    const fetcher = makeGdeltFetcher({ fetchImpl, pacer: noPacer });
    const json = await fetcher('https://api.gdeltproject.org/x');
    expect(calls).toBe(3); // failed twice, succeeded on the third attempt
    expect(() => GdeltTimelineResponseSchema.parse(json)).not.toThrow();
  });

  it('rides out a rate-limit notice and then succeeds', async () => {
    let calls = 0;
    const fetchImpl: ResponseFetcher = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(textRes('Please limit requests to one every 5 seconds'))
        : Promise.resolve(jsonRes({ timeline: [] }));
    };
    const fetcher = makeGdeltFetcher({ fetchImpl, pacer: noPacer });
    const json = await fetcher('https://api.gdeltproject.org/x');
    expect(calls).toBe(2);
    expect(json).toEqual({ timeline: [] });
  });

  it('paces every request — initial AND retry — through the gate', async () => {
    let acquires = 0;
    const pacer: GdeltPacer = {
      acquire: () => {
        acquires += 1;
        return Promise.resolve();
      },
    };
    let calls = 0;
    const seenRetries: (number | undefined)[] = [];
    const fetchImpl: ResponseFetcher = (_url, opts) => {
      calls += 1;
      seenRetries.push(opts.retries);
      return calls < 3
        ? Promise.reject(transportError())
        : Promise.resolve(jsonRes({ timeline: [] }));
    };
    await makeGdeltFetcher({ fetchImpl, pacer })(
      'https://api.gdeltproject.org/x'
    );
    expect(acquires).toBe(3); // one acquire before each of the 3 attempts
    // Inner retries MUST be 0 so fetchWithRetry never fires an un-paced retry.
    expect(seenRetries).toEqual([0, 0, 0]);
  });

  it('retries a 5xx but fails fast (no retry) on a 4xx', async () => {
    let calls = 0;
    const fetchImpl: ResponseFetcher = () => {
      calls += 1;
      return Promise.resolve(textRes('bad query', 400));
    };
    const fetcher = makeGdeltFetcher({ fetchImpl, pacer: noPacer });
    await expect(
      fetcher('https://api.gdeltproject.org/x')
    ).rejects.toBeInstanceOf(GdeltResponseError);
    expect(calls).toBe(1); // 4xx is not retried
  });

  it('throws a typed error unwrapping the cause after exhausting retries', async () => {
    let calls = 0;
    const fetchImpl: ResponseFetcher = () => {
      calls += 1;
      return Promise.reject(transportError());
    };
    const fetcher = makeGdeltFetcher({
      fetchImpl,
      pacer: noPacer,
      maxRetries: 2,
    });
    await expect(fetcher('https://api.gdeltproject.org/x')).rejects.toThrow(
      /fetch failed.*other side closed.*UND_ERR_SOCKET/
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});

describe('createGdeltPacer (1-req/5s gate)', () => {
  it('does not delay the first request, then spaces each subsequent one', async () => {
    const waits: number[] = [];
    const pacer = createGdeltPacer(6000, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    // First acquire has no prior request → no wait. The next two each wait ~gap.
    expect(waits).toHaveLength(2);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(5000);
  });

  it('serializes concurrent acquires in FIFO order (no overlap)', async () => {
    const order: string[] = [];
    const pacer = createGdeltPacer(0, () => Promise.resolve());
    const a = pacer.acquire().then(() => order.push('a'));
    const b = pacer.acquire().then(() => order.push('b'));
    const c = pacer.acquire().then(() => order.push('c'));
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
