import { describe, it, expect } from 'vitest';
import {
  makeFirmsCollector,
  aggregateDaily,
  buildFirmsUrl,
  UKRAINE_BBOX,
} from '../../../src/lib/sources/firms';
import {
  parseFirmsCsv,
  FirmsFireRowsSchema,
} from '../../../src/lib/sources/firms.schema';
import type { Env } from '../../../src/lib/types';

// Minimal Env stub. FIRMS_MAP_KEY is not on the frozen Env type, so we add it
// via an intersection cast for the tests (mirrors how the collector reads it).
function envWithKey(key?: string): Env {
  const base = {} as Env;
  if (key !== undefined) {
    (base as unknown as Record<string, unknown>)['FIRMS_MAP_KEY'] = key;
  }
  return base;
}

// Realistic VIIRS_SNPP_NRT area CSV: header + detections across two UTC days,
// plus a low-confidence row, to exercise parse + aggregation.
const REAL_CSV = `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
48.51234,37.81234,330.1,0.42,0.39,2026-05-16,2312,N,VIIRS,n,2.0NRT,295.2,4.1,N
49.10010,38.20020,341.7,0.40,0.38,2026-05-16,0102,N,VIIRS,h,2.0NRT,300.4,7.8,N
47.90011,37.10090,318.0,0.55,0.48,2026-05-16,1148,N,VIIRS,l,2.0NRT,290.0,1.2,D
50.44444,36.99999,360.2,0.41,0.39,2026-05-17,0034,N,VIIRS,n,2.0NRT,305.9,12.4,N
46.70001,32.10002,322.5,0.50,0.45,2026-05-17,1059,N,VIIRS,h,2.0NRT,292.3,2.0,D`;

describe('parseFirmsCsv', () => {
  it('parses header-keyed rows from realistic CSV', () => {
    const rows = parseFirmsCsv(REAL_CSV);
    expect(rows).toHaveLength(5);
    expect(rows[0].acq_date).toBe('2026-05-16');
    expect(rows[0].latitude).toBe('48.51234');
    expect(rows[3].acq_date).toBe('2026-05-17');
    expect(rows[2].confidence).toBe('l');
  });

  it('strips a UTF-8 BOM and trims whitespace', () => {
    const rows = parseFirmsCsv('﻿' + REAL_CSV + '\n');
    expect(rows).toHaveLength(5);
  });

  it('returns [] for empty / whitespace-only input', () => {
    expect(parseFirmsCsv('')).toEqual([]);
    expect(parseFirmsCsv('   \n  \n')).toEqual([]);
  });

  it('skips rows whose column count mismatches the header', () => {
    const csv =
      'latitude,longitude,acq_date,acq_time\n' +
      '48.5,37.8,2026-05-16,2312\n' +
      '49.0,38.2,2026-05-16\n' + // short row -> skipped
      '47.9,37.1,2026-05-17,1148\n';
    const rows = parseFirmsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.acq_date)).toEqual(['2026-05-16', '2026-05-17']);
  });

  it('throws on garbage / FIRMS error body (no acq_date header)', () => {
    expect(() => parseFirmsCsv('Invalid MAP_KEY.')).toThrow(/acq_date/);
    expect(() => parseFirmsCsv('not,a,fire,csv\n1,2,3,4')).toThrow(/acq_date/);
  });
});

describe('FirmsFireRowsSchema', () => {
  it('validates well-formed parsed rows', () => {
    const rows = FirmsFireRowsSchema.parse(parseFirmsCsv(REAL_CSV));
    expect(rows).toHaveLength(5);
    expect(rows[0].acq_date).toBe('2026-05-16');
  });

  it('rejects a row with a malformed acq_date', () => {
    const bad = [{ acq_date: '20260516' }];
    expect(() => FirmsFireRowsSchema.parse(bad)).toThrow();
  });
});

describe('aggregateDaily', () => {
  it('counts detections per UTC day, sorted ascending, ISO-8601 UTC ts', () => {
    const rows = FirmsFireRowsSchema.parse(parseFirmsCsv(REAL_CSV));
    const snaps = aggregateDaily(rows);
    expect(snaps).toEqual([
      {
        metric: 'fire_anomalies',
        source: 'firms',
        ts: '2026-05-16T00:00:00Z',
        value: 3,
        confidence: 1,
      },
      {
        metric: 'fire_anomalies',
        source: 'firms',
        ts: '2026-05-17T00:00:00Z',
        value: 2,
        confidence: 1,
      },
    ]);
    for (const s of snaps) {
      expect(new Date(s.ts).toISOString()).toBe(
        new Date(s.ts).toISOString()
      );
      expect(s.ts.endsWith('Z')).toBe(true);
    }
  });

  it('returns [] for no rows', () => {
    expect(aggregateDaily([])).toEqual([]);
  });
});

describe('buildFirmsUrl', () => {
  it('builds the documented area CSV endpoint with the Ukraine bbox', () => {
    const url = buildFirmsUrl('abc123');
    expect(url).toBe(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/abc123/VIIRS_SNPP_NRT/' +
        UKRAINE_BBOX +
        '/7'
    );
  });

  it('url-encodes the map key', () => {
    expect(buildFirmsUrl('a/b c')).toContain('/a%2Fb%20c/');
  });
});

describe('firmsCollector.run', () => {
  it('parses, validates, and aggregates via an injected fetcher', async () => {
    const collector = makeFirmsCollector({
      fetcher: async (url) => {
        expect(url).toContain('/VIIRS_SNPP_NRT/');
        expect(url).toContain('/KEY/');
        return REAL_CSV;
      },
    });
    const result = await collector.run(envWithKey('KEY'));
    expect(collector.name).toBe('firms');
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]).toMatchObject({
      metric: 'fire_anomalies',
      source: 'firms',
      ts: '2026-05-16T00:00:00Z',
      value: 3,
    });
    expect(result.markets).toBeUndefined();
  });

  it('throws a clear error when FIRMS_MAP_KEY is absent', async () => {
    const collector = makeFirmsCollector({
      fetcher: async () => REAL_CSV,
    });
    await expect(collector.run(envWithKey())).rejects.toThrow(
      /FIRMS_MAP_KEY is missing/
    );
  });

  it('throws when FIRMS returns an error body (no acq_date header)', async () => {
    const collector = makeFirmsCollector({
      fetcher: async () => 'Invalid MAP_KEY.',
    });
    await expect(collector.run(envWithKey('KEY'))).rejects.toThrow(/acq_date/);
  });

  it('produces no snapshots for a header-only (zero-fire) CSV', async () => {
    const collector = makeFirmsCollector({
      fetcher: async () =>
        'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    });
    const result = await collector.run(envWithKey('KEY'));
    expect(result.snapshots).toEqual([]);
  });
});
