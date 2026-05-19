import { describe, it, expect } from 'vitest';
import {
  parseCsvLine,
  mapOryxCsv,
  createOryxCollector,
  OryxSourceError,
  RU_LOSS_METRIC,
  UA_LOSS_METRIC,
  ORYX_SOURCE,
} from '../../../src/lib/sources/oryx';
import type { Env } from '../../../src/lib/types';

const HEADER =
  'country,origin,system,status,url,date_recorded,sysID,imageID,statusID,matID';
// system field deliberately contains a comma + quotes to exercise the parser.
const CSV = [
  HEADER,
  'Russia,Russia,"T-72B3, mod. 2016",destroyed,https://x/1,2022-03-19,1,1,1,1',
  'Russia,Russia,Su-34,destroyed,https://x/2,2022-03-19,2,2,1,2',
  'Ukraine,Ukraine,BMP-2,captured,https://x/3,2022-03-20,3,3,3,3',
  'Russia,Russia,BTR-82A,abandoned,https://x/4,2022-04-01,4,4,2,4',
  // a third-party / non-belligerent row must be ignored
  'Belarus,Belarus,Decoy,destroyed,https://x/5,2022-04-01,5,5,1,5',
  // malformed date must be skipped, never fabricated
  'Ukraine,Ukraine,T-64,destroyed,https://x/6,not-a-date,6,6,1,6',
].join('\n');

describe('parseCsvLine', () => {
  it('splits plain and quoted fields (commas/quotes inside quotes)', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvLine('Russia,"T-72, mod","he said ""hi"""')).toEqual([
      'Russia',
      'T-72, mod',
      'he said "hi"',
    ]);
  });
});

describe('mapOryxCsv', () => {
  it('emits cumulative per-country confirmed-loss snapshots', () => {
    const snaps = mapOryxCsv(CSV);
    const ru = snaps
      .filter((s) => s.metric === RU_LOSS_METRIC)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const ua = snaps.filter((s) => s.metric === UA_LOSS_METRIC);

    expect(ru.map((s) => [s.ts, s.value])).toEqual([
      ['2022-03-19T00:00:00.000Z', 2], // two RU rows that day
      ['2022-04-01T00:00:00.000Z', 3], // +1 abandoned → cumulative 3
    ]);
    expect(ua).toEqual([
      expect.objectContaining({
        metric: UA_LOSS_METRIC,
        source: ORYX_SOURCE,
        ts: '2022-03-20T00:00:00.000Z',
        value: 1, // the bad-date UA row was skipped, not counted
        confidence: 1,
      }),
    ]);
    // Belarus row ignored entirely.
    expect(snaps.every((s) => s.source === 'oryx')).toBe(true);
  });

  it('throws a typed error on header-only / missing columns', () => {
    expect(() => mapOryxCsv(HEADER)).toThrow(OryxSourceError);
    expect(() => mapOryxCsv('a,b\n1,2')).toThrow(/country|date_recorded/);
  });
});

describe('createOryxCollector', () => {
  it('maps the fetched CSV to snapshots', async () => {
    const collector = createOryxCollector(async () => CSV);
    expect(collector.name).toBe('oryx');
    const { snapshots } = await collector.run({} as Env);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(new Set(snapshots.map((s) => s.metric))).toEqual(
      new Set([RU_LOSS_METRIC, UA_LOSS_METRIC])
    );
  });

  it('throws OryxSourceError when the source is unreachable', async () => {
    const collector = createOryxCollector(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(collector.run({} as Env)).rejects.toBeInstanceOf(
      OryxSourceError
    );
  });
});
