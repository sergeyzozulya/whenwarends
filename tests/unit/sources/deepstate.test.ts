import { describe, it, expect } from 'vitest';
import {
  ringAreaM2,
  polygonAreaM2,
  geometryAreaKm2,
  collectionAreaKm2,
  dailyUrl,
  dateToIsoUtc,
  mapDay,
  createDeepStateCollector,
  collectDeepStateHistory,
  rawGeometryAreaKm2,
  occupiedFromApi,
  collectDeepStateMonthlyHistory,
  apiSnapshotUrl,
  DEEPSTATE_SOURCE,
  OCCUPIED_AREA_METRIC,
  type GeoJsonFetcher,
  type JsonFetcher,
} from '../../../src/lib/sources/deepstate';
import { FeatureCollectionSchema } from '../../../src/lib/sources/deepstate.schema';

// A 1°×1° square on the equator. Real geodesic area ≈ 12,308 km²
// (1° lon ≈ 111.32 km × 1° lat ≈ 110.57 km). Rings are [lon, lat].
const equatorSquare = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

function featureCollection(geometry: unknown) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] };
}

describe('spherical area', () => {
  it('computes a 1°×1° equatorial square at ~12,308 km²', () => {
    const km2 = Math.abs(ringAreaM2(equatorSquare)) / 1e6;
    expect(km2).toBeGreaterThan(12_000);
    expect(km2).toBeLessThan(12_600);
  });

  it('subtracts holes from a polygon (outer ring minus inner ring)', () => {
    const outer = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    const hole = [
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
      [0.5, 1.5],
      [0.5, 0.5],
    ];
    const solid = polygonAreaM2([outer]);
    const withHole = polygonAreaM2([outer, hole]);
    expect(withHole).toBeLessThan(solid);
    // Hole area ≈ a 1°×1° square; withHole ≈ solid − hole.
    expect((solid - withHole) / 1e6).toBeGreaterThan(11_500);
    expect((solid - withHole) / 1e6).toBeLessThan(12_800);
  });

  it('sums polygons across a MultiPolygon geometry', () => {
    const one = geometryAreaKm2({ type: 'Polygon', coordinates: [equatorSquare] });
    const two = geometryAreaKm2({
      type: 'MultiPolygon',
      coordinates: [[equatorSquare], [equatorSquare]],
    });
    expect(two).toBeCloseTo(one * 2, 3);
  });
});

describe('FeatureCollectionSchema', () => {
  it('parses a FeatureCollection with a MultiPolygon and ignores extra keys', () => {
    const fc = FeatureCollectionSchema.parse({
      type: 'FeatureCollection',
      name: 'occupied',
      crs: { type: 'name' },
      features: [
        { type: 'Feature', properties: { date: '2026-05-22' }, geometry: { type: 'MultiPolygon', coordinates: [[equatorSquare]] } },
      ],
    });
    expect(fc.features).toHaveLength(1);
  });

  it('rejects a non-polygon geometry (Point/LineString)', () => {
    expect(() =>
      FeatureCollectionSchema.parse(featureCollection({ type: 'Point', coordinates: [1, 2] }))
    ).toThrow();
  });
});

describe('dailyUrl + dateToIsoUtc', () => {
  it('zero-pads the YYYYMMDD filename', () => {
    expect(dailyUrl(2026, 5, 2)).toBe(
      'https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data/deepstatemap_data_20260502.geojson'
    );
  });
  it('pins a UTC calendar date to midnight Z', () => {
    expect(dateToIsoUtc(2026, 5, 2)).toBe('2026-05-02T00:00:00.000Z');
  });
});

describe('mapDay', () => {
  it('maps one day to a single occupied-area snapshot', () => {
    const snap = mapDay(
      JSON.stringify(featureCollection({ type: 'Polygon', coordinates: [equatorSquare] })),
      '2026-05-22T00:00:00.000Z'
    );
    expect(snap.metric).toBe(OCCUPIED_AREA_METRIC);
    expect(snap.source).toBe(DEEPSTATE_SOURCE);
    expect(snap.ts).toBe('2026-05-22T00:00:00.000Z');
    expect(snap.value).toBeGreaterThan(12_000);
    expect(snap.confidence).toBe(1);
  });
});

describe('createDeepStateCollector', () => {
  const body = JSON.stringify(featureCollection({ type: 'Polygon', coordinates: [equatorSquare] }));

  it('uses today when present', async () => {
    const now = () => new Date('2026-05-22T08:00:00Z');
    const fetcher: GeoJsonFetcher = async (url) =>
      url.includes('20260522') ? body : null;
    const result = await createDeepStateCollector(fetcher, 7, now).run({} as never);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].ts).toBe('2026-05-22T00:00:00.000Z');
  });

  it('walks back to the most recent published day when today is missing', async () => {
    const now = () => new Date('2026-05-22T08:00:00Z');
    const seen: string[] = [];
    const fetcher: GeoJsonFetcher = async (url) => {
      seen.push(url);
      return url.includes('20260520') ? body : null; // today + yesterday 404
    };
    const result = await createDeepStateCollector(fetcher, 7, now).run({} as never);
    expect(result.snapshots[0].ts).toBe('2026-05-20T00:00:00.000Z');
    expect(seen.length).toBe(3); // 22 (null) → 21 (null) → 20 (hit)
  });

  it('throws when no file exists within the lookback window', async () => {
    const now = () => new Date('2026-05-22T08:00:00Z');
    const collector = createDeepStateCollector(async () => null, 3, now);
    await expect(collector.run({} as never)).rejects.toThrow(/no daily file/);
  });
});

describe('collectDeepStateHistory', () => {
  it('emits one snapshot per published day and skips gaps', async () => {
    const body = JSON.stringify(featureCollection({ type: 'Polygon', coordinates: [equatorSquare] }));
    const fetcher: GeoJsonFetcher = async (url) =>
      url.includes('20240709') ? null : body; // one gap day
    const { snapshots } = await collectDeepStateHistory(
      '2024-07-08',
      '2024-07-11',
      fetcher,
      0
    );
    // 8th, 10th, 11th present; 9th is a gap → 3 points, never fabricated.
    expect(snapshots.map((s) => s.ts)).toEqual([
      '2024-07-08T00:00:00.000Z',
      '2024-07-10T00:00:00.000Z',
      '2024-07-11T00:00:00.000Z',
    ]);
    expect(snapshots.every((s) => s.metric === OCCUPIED_AREA_METRIC)).toBe(true);
  });
});

// --- DeepState live-API monthly history (pre-mirror backfill) ---------------

/** A size°×size° square at the equator (rough but monotonic area). */
const sq = (size: number) => [
  [0, 0],
  [size, 0],
  [size, size],
  [0, size],
  [0, 0],
];
const apiFeat = (fill: string, ring: number[][]) => ({
  type: 'Feature',
  properties: { fill },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
// A snapshot: Crimea zone (#880e4f), occupied-since-2022 (#a52714), a liberated
// zone (#0f9d58, must be excluded) and a Point icon (area 0, must be ignored).
const apiSnap = (crimeaSize: number, occSize: number) => ({
  type: 'FeatureCollection',
  features: [
    apiFeat('#880e4f', sq(crimeaSize)),
    apiFeat('#a52714', sq(occSize)),
    apiFeat('#0f9d58', sq(1)),
    { type: 'Feature', properties: { fill: '#000' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ],
});

describe('rawGeometryAreaKm2', () => {
  it('areas a polygon and ignores non-polygon geometry', () => {
    expect(rawGeometryAreaKm2({ type: 'Polygon', coordinates: [sq(1)] })).toBeGreaterThan(12_000);
    expect(rawGeometryAreaKm2({ type: 'Point', coordinates: [1, 1] })).toBe(0);
    expect(rawGeometryAreaKm2(null)).toBe(0);
  });
});

describe('occupiedFromApi', () => {
  it('sums only the occupied fills, and reports the Crimea baseline', () => {
    const { occupied, crimea } = occupiedFromApi(apiSnap(2, 2).features);
    const oneSquare = rawGeometryAreaKm2({ type: 'Polygon', coordinates: [sq(2)] });
    // occupied = #880e4f + #a52714 (two 2° squares); green + point excluded.
    expect(occupied).toBeCloseTo(oneSquare * 2, 0);
    expect(crimea).toBeCloseTo(oneSquare, 0);
  });
});

describe('collectDeepStateMonthlyHistory', () => {
  const aug = Math.floor(Date.UTC(2022, 7, 31) / 1000);
  const sep = Math.floor(Date.UTC(2022, 8, 30) / 1000);
  const oct = Math.floor(Date.UTC(2022, 9, 31) / 1000);

  it('emits complete months and gates out the mapping-in-progress ones', async () => {
    const listFetcher: JsonFetcher = async () => [{ id: aug }, { id: sep }, { id: oct }];
    const snapFetcher: JsonFetcher = async (url) => {
      const id = Number(/history\/(\d+)\/geojson/.exec(url)![1]);
      if (id === aug) return { map: apiSnap(1, 1) }; // wrapped + incomplete (Crimea ~12k < 40k)
      if (id === sep) return apiSnap(2, 3); // bare FC, complete
      if (id === oct) return apiSnap(2, 2); // complete
      throw new Error(`unexpected id ${id}`);
    };

    const { snapshots } = await collectDeepStateMonthlyHistory({
      from: '2022-08-01',
      to: '2022-11-01',
      listFetcher,
      snapFetcher,
      delayMs: 0,
    });

    // Aug gated out (incomplete map); Sep + Oct emitted.
    expect(snapshots.map((s) => s.ts)).toEqual([
      '2022-09-30T00:00:00.000Z',
      '2022-10-31T00:00:00.000Z',
    ]);
    expect(snapshots.every((s) => s.metric === OCCUPIED_AREA_METRIC)).toBe(true);
    expect(snapshots.every((s) => s.source === DEEPSTATE_SOURCE)).toBe(true);
    expect(snapshots[0].value).toBeGreaterThan(40_000); // Crimea + occupied
  });

  it('builds the documented per-snapshot geojson URL', () => {
    expect(apiSnapshotUrl(123)).toBe('https://deepstatemap.live/api/history/123/geojson');
  });
});
