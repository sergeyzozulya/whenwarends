// DeepState collector — Russian-occupied area of Ukraine (km²), the most
// direct "is the war moving" signal for the front-line widget.
//
// Source: DeepState (deepstatemap.live), Ukrainian volunteer OSINT. We read
// the machine-readable GitHub mirror's DAILY occupied-territory GeoJSON:
//   https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data/deepstatemap_data_<YYYYMMDD>.geojson
//
// LICENSING (see CLAUDE.md): the mirror REPO is GPL-3.0. We derive and store
// ONLY a single scalar per day — the occupied area in km², a non-copyrightable
// FACT — and never persist the geometry itself. The widget credits DeepState
// and labels the figure Ukrainian OSINT. Owner decision (2026-05-22): derive
// the km² fact only.
//
// Area is computed with the Chamberlain–Duquette spherical-excess formula (the
// same one @turf/area uses), so no geometry dependency is added. Validated
// against the live 2026-05-22 file: 116,861 km² (~19.4% of Ukraine), matching
// the real occupied share. The daily file is ONE Feature (a MultiPolygon); we
// sum area across every feature defensively in case it is ever split.
//
// Freshness: the mirror updates ~03:00 UTC. We try today's file and walk back
// up to LOOKBACK_DAYS days (a missing day returns 404 → null), so a lagging or
// skipped publish degrades to the most recent real day rather than failing.
// History (2022→now) is seeded once by scripts/backfill-frontline.ts from the
// unified .geojson.gz; this daily collector only appends the freshest point.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchWithRetry } from './contract';
import {
  FeatureCollectionSchema,
  ApiHistoryListSchema,
  ApiFeatureCollectionSchema,
  type FeatureCollection,
  type Geometry,
  type ApiFeature,
} from './deepstate.schema';

export const DEEPSTATE_SOURCE = 'deepstate';
export const OCCUPIED_AREA_METRIC = 'occupied_area_km2';

const RAW_BASE =
  'https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data';
/** How many days back to try when today's file is not yet published. */
const LOOKBACK_DAYS = 7;

/** WGS84 semi-major axis (m) — the radius @turf/area uses. */
const EARTH_RADIUS_M = 6378137;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Signed spherical area (m²) of one linear ring (Chamberlain & Duquette).
 * Sign encodes winding; callers take the absolute value and subtract holes.
 */
export function ringAreaM2(ring: number[][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    total += (toRad(lon2) - toRad(lon1)) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return (total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2;
}

/** Area (m²) of one polygon: outer ring minus its holes. */
export function polygonAreaM2(rings: number[][][]): number {
  if (rings.length === 0) return 0;
  let area = Math.abs(ringAreaM2(rings[0]));
  for (let i = 1; i < rings.length; i++) area -= Math.abs(ringAreaM2(rings[i]));
  return Math.max(0, area);
}

/** Area (km²) of a Polygon or MultiPolygon geometry. */
export function geometryAreaKm2(geom: Geometry): number {
  const m2 =
    geom.type === 'Polygon'
      ? polygonAreaM2(geom.coordinates)
      : geom.coordinates.reduce((s, poly) => s + polygonAreaM2(poly), 0);
  return m2 / 1e6;
}

/** Total occupied area (km²) across every feature in a collection. */
export function collectionAreaKm2(fc: FeatureCollection): number {
  return fc.features.reduce((s, f) => s + geometryAreaKm2(f.geometry), 0);
}

/** Daily file URL for a given UTC date. */
export function dailyUrl(year: number, month: number, day: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${RAW_BASE}/deepstatemap_data_${year}${p(month)}${p(day)}.geojson`;
}

/** ISO midnight-Z timestamp for a UTC calendar date. */
export function dateToIsoUtc(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

/**
 * Injectable fetcher. Returns the GeoJSON text, or `null` when the file does
 * not exist (HTTP 404) so the collector can walk back to an earlier day.
 * Throws on other errors so the runner isolates a genuine failure.
 */
export type GeoJsonFetcher = (url: string) => Promise<string | null>;

const defaultFetcher: GeoJsonFetcher = async (url) => {
  const res = await fetchWithRetry(url, {
    init: { headers: { accept: 'application/geo+json, application/json' } },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DeepState HTTP ${res.status} for ${url}`);
  return res.text();
};

/** Parse + map one day's GeoJSON to a single occupied-area snapshot. */
export function mapDay(
  text: string,
  isoTs: string
): SnapshotInput {
  const fc = FeatureCollectionSchema.parse(JSON.parse(text));
  const km2 = collectionAreaKm2(fc);
  return {
    metric: OCCUPIED_AREA_METRIC,
    source: DEEPSTATE_SOURCE,
    ts: isoTs,
    value: km2,
    confidence: 1,
    raw_blob: JSON.stringify({ polygons: fc.features.length }),
  };
}

export function createDeepStateCollector(
  fetcher: GeoJsonFetcher = defaultFetcher,
  lookbackDays: number = LOOKBACK_DAYS,
  now: () => Date = () => new Date()
): Collector {
  return {
    name: DEEPSTATE_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const base = now();
      for (let back = 0; back <= lookbackDays; back++) {
        const d = new Date(base.getTime() - back * 86400_000);
        const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
        const text = await fetcher(dailyUrl(y, m, day));
        if (text === null) continue; // not published for that day — walk back
        return { snapshots: [mapDay(text, dateToIsoUtc(y, m, day))] };
      }
      throw new Error(
        `DeepState: no daily file found within the last ${lookbackDays} days`
      );
    },
  };
}

export const deepStateCollector: Collector = createDeepStateCollector();

// ---------------------------------------------------------------------------
// One-time history backfill (NOT part of the daily run).

/** Earliest daily file the mirror publishes (verified 2026-05-22). */
export const HISTORY_START_DATE = '2024-07-08';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk every UTC day in [from, to] and map that day's occupied-area file to a
 * snapshot — skipping days with no published file (404 → null) or a malformed
 * body, never fabricating a point. The daily filenames carry real dates back
 * to 2024-07-08, so this yields ~22 months of genuine daily history (the gz
 * unified file only dates its most recent ~6 months). Heavy (~one request per
 * day), so it is a manual one-time script, not the daily collect; idempotent
 * because filestore dedupes on (metric,source,ts). `delayMs` throttles the
 * real network fetcher; tests pass 0.
 */
export async function collectDeepStateHistory(
  from: string = HISTORY_START_DATE,
  to?: string,
  fetcher: GeoJsonFetcher = defaultFetcher,
  delayMs = 120
): Promise<CollectorResult> {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = (to ? new Date(`${to}T00:00:00Z`) : new Date()).getTime();
  const snapshots: SnapshotInput[] = [];
  for (let t = start; t <= end; t += 86400_000) {
    const d = new Date(t);
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    let text: string | null;
    try {
      text = await fetcher(dailyUrl(y, m, day));
    } catch {
      continue; // one transient day must not sink the whole backfill
    }
    if (text === null) continue; // no file that day (gap) — skip, never fill
    try {
      snapshots.push(mapDay(text, dateToIsoUtc(y, m, day)));
    } catch {
      continue; // a malformed day is skipped, never fabricated
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return { snapshots };
}

// ---------------------------------------------------------------------------
// Monthly pre-mirror history from DeepState's OWN API.
//
// The cyterat mirror only reaches back to 2024-07-08. DeepState's live API
// lists every snapshot since the invasion (/api/history/public), so we sample
// it MONTHLY to extend the front line back to late 2022 — staying with
// DeepState and reconciling to the mirror (current API occupied = 116,862 km²
// vs mirror 116,861). Occupied = the "occupied since 2022" zone (#a52714) plus
// the Crimea / pre-2022 zone (#880e4f), the same total the mirror produces.
//
// Honest cutoff: DeepState was still drawing the map in the first ~6 months, so
// early snapshots are mapping-in-progress, not ground truth (e.g. July 2022
// has the Crimea zone barely marked). We gate on that pre-2022 baseline being
// fully present (#880e4f ≥ ~40k km²) and skip incomplete months — so the
// series begins where the data becomes trustworthy (~Sept 2022), never
// fabricating the opening months.

const API_BASE = 'https://deepstatemap.live/api';
export const API_HISTORY_LIST_URL = `${API_BASE}/history/public`;
export const apiSnapshotUrl = (id: number): string =>
  `${API_BASE}/history/${id}/geojson`;

const DS_API_INIT: RequestInit = {
  headers: {
    'User-Agent':
      'WhenWarEnds/1.0 (+https://whenwarends.org; non-commercial dashboard)',
    Accept: 'application/json',
  },
};

// Occupied-territory fill colours (validated against the mirror, 2026-05).
const OCCUPIED_FILLS = new Set(['#a52714', '#880e4f']);
// The pre-2022 baseline zone (Crimea + old Donbas, ~43.8k km²) — used as a
// map-completeness gate; below this the snapshot predates a finished map.
const CRIMEA_FILL = '#880e4f';
const COMPLETENESS_MIN_KM2 = 40_000;

/** JSON fetcher (injectable for tests). */
export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultJsonFetcher: JsonFetcher = async (url) => {
  const res = await fetchWithRetry(url, { init: DS_API_INIT });
  if (!res.ok) throw new Error(`DeepState API HTTP ${res.status} for ${url}`);
  return res.json();
};

/** Area (km²) of a loose API geometry — only Polygon/MultiPolygon contribute. */
export function rawGeometryAreaKm2(
  geom: { type: string; coordinates?: unknown } | null | undefined
): number {
  if (!geom) return 0;
  if (geom.type === 'Polygon')
    return polygonAreaM2(geom.coordinates as number[][][]) / 1e6;
  if (geom.type === 'MultiPolygon')
    return (
      (geom.coordinates as number[][][][]).reduce(
        (s, poly) => s + polygonAreaM2(poly),
        0
      ) / 1e6
    );
  return 0;
}

/** Occupied km² and the Crimea-baseline km² (for the completeness gate). */
export function occupiedFromApi(features: ApiFeature[]): {
  occupied: number;
  crimea: number;
} {
  let occupied = 0;
  let crimea = 0;
  for (const f of features) {
    const fill = f.properties?.fill;
    if (fill === undefined) continue;
    const area = rawGeometryAreaKm2(f.geometry ?? null);
    if (fill === CRIMEA_FILL) crimea += area;
    if (OCCUPIED_FILLS.has(fill)) occupied += area;
  }
  return { occupied, crimea };
}

/** Some snapshot endpoints wrap the FeatureCollection as { map: … }. */
function extractFeatureCollection(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'map' in raw) {
    return (raw as { map: unknown }).map;
  }
  return raw;
}

/** Last-day-of-month UTC instants for each month in [from, to). */
function monthEndTargets(fromIso: string, toIso: string): number[] {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const toMs = new Date(`${toIso}T00:00:00Z`).getTime();
  const out: number[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth(); // 0-based
  for (;;) {
    const end = Date.UTC(y, m + 1, 0); // last day of month m
    if (end >= toMs) break;
    out.push(end);
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** Snapshot in `sorted` (ascending by id) whose timestamp is nearest `ms`. */
function nearestSnapshot<T extends { id: number }>(
  sorted: T[],
  ms: number
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const s of sorted) {
    const d = Math.abs(s.id * 1000 - ms);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * Sample DeepState's API monthly over [from, to) and emit one occupied-area
 * snapshot per month whose map is complete (Crimea baseline present). Defaults
 * cover the pre-mirror gap: 2022-08 → the mirror's daily start. Per-month
 * failures are skipped (never fabricated); idempotent via the ts dedupe.
 */
export async function collectDeepStateMonthlyHistory(
  opts: {
    from?: string;
    to?: string;
    listFetcher?: JsonFetcher;
    snapFetcher?: JsonFetcher;
    delayMs?: number;
  } = {}
): Promise<CollectorResult> {
  const listFetcher = opts.listFetcher ?? defaultJsonFetcher;
  const snapFetcher = opts.snapFetcher ?? defaultJsonFetcher;
  const from = opts.from ?? '2022-08-01';
  const to = opts.to ?? HISTORY_START_DATE; // hand off to the daily mirror
  const delayMs = opts.delayMs ?? 120;

  const list = ApiHistoryListSchema.parse(await listFetcher(API_HISTORY_LIST_URL));
  const sorted = [...list].sort((a, b) => a.id - b.id);

  const snapshots: SnapshotInput[] = [];
  const seen = new Set<number>();
  for (const target of monthEndTargets(from, to)) {
    const snap = nearestSnapshot(sorted, target);
    if (!snap || seen.has(snap.id)) continue;
    seen.add(snap.id);

    let raw: unknown;
    try {
      raw = await snapFetcher(apiSnapshotUrl(snap.id));
    } catch {
      continue; // one transient month must not sink the backfill
    }
    let fc;
    try {
      fc = ApiFeatureCollectionSchema.parse(extractFeatureCollection(raw));
    } catch {
      continue; // a malformed snapshot is skipped, never fabricated
    }
    const { occupied, crimea } = occupiedFromApi(fc.features);
    if (crimea < COMPLETENESS_MIN_KM2) continue; // map still being drawn — skip

    // Pin to midnight Z of the snapshot's own UTC day.
    const day = new Date(snap.id * 1000).toISOString().slice(0, 10);
    snapshots.push({
      metric: OCCUPIED_AREA_METRIC,
      source: DEEPSTATE_SOURCE,
      ts: `${day}T00:00:00.000Z`,
      value: occupied,
      confidence: 1,
      raw_blob: JSON.stringify({ via: 'api', id: snap.id }),
    });
    if (delayMs > 0) await sleep(delayMs);
  }
  return { snapshots };
}
