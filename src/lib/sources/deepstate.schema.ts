import { z } from 'zod';

// Zod schema for the DeepState occupied-territory GeoJSON.
//
// Source (Ukrainian volunteer OSINT; daily multipolygon of Russian-occupied
// territory). We read the machine-readable mirror:
//   daily: https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data/deepstatemap_data_<YYYYMMDD>.geojson
//   full : https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/deepstate-map-data.geojson.gz
//
// Live-verified shape (2026-05-22): a GeoJSON `FeatureCollection`. The daily
// file holds ONE `Feature` whose geometry is a `MultiPolygon` (18 polygons) of
// the occupied area, with empty `properties` ({}). The unified history file
// holds many `Feature`s, each a dated occupied snapshot with
// `properties.date`. We consume only the geometry (to derive occupied km², a
// non-copyrightable fact) and, in the history file, `properties.date`.
//
// We deliberately validate only what we use: geometry must be a Polygon or
// MultiPolygon of numeric positions; everything else is passthrough so an added
// CRS block or property never breaks parsing. We do NOT store the geometry —
// only the derived area — so the GPL-licensed mirror's geometry never lands in
// the repo (see CLAUDE.md "Licensing").

/** A GeoJSON position: [lon, lat] (+ optional elevation), lon/lat are all we read. */
const PositionSchema = z.array(z.number()).min(2);
/** A linear ring: a closed array of positions. */
const RingSchema = z.array(PositionSchema);

export const PolygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(RingSchema),
});

export const MultiPolygonGeometrySchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(RingSchema)),
});

/** Either polygon kind; anything else (Point, LineString, …) is rejected. */
export const GeometrySchema = z.discriminatedUnion('type', [
  PolygonGeometrySchema,
  MultiPolygonGeometrySchema,
]);

export type Geometry = z.infer<typeof GeometrySchema>;

export const FeatureSchema = z
  .object({
    type: z.literal('Feature'),
    // History features carry { date: "YYYY-MM-DD" | null }; daily files are {}.
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    geometry: GeometrySchema,
  })
  .passthrough();

export type Feature = z.infer<typeof FeatureSchema>;

export const FeatureCollectionSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(FeatureSchema),
  })
  .passthrough();

export type FeatureCollection = z.infer<typeof FeatureCollectionSchema>;

// ---------------------------------------------------------------------------
// DeepState's OWN live API (deepstatemap.live), used only for the monthly
// pre-mirror history backfill. Unlike the cyterat mirror (one clean occupied
// MultiPolygon), the live map is hundreds of status-coloured features of mixed
// geometry (Polygon, Point icons, …), so the schema is permissive: we keep the
// `fill` colour (to select occupied zones) and a loose geometry, and the area
// helper computes area only for Polygon/MultiPolygon. Live-verified 2026-05.

/** Snapshot list at /api/history/public — id is a Unix-seconds timestamp. */
export const ApiHistoryListSchema = z.array(
  z.object({ id: z.number() }).passthrough()
);

/** A loose geometry: any type; coordinates validated structurally by the area
 *  helper (only Polygon/MultiPolygon contribute area). */
export const ApiGeometrySchema = z
  .object({ type: z.string(), coordinates: z.unknown() })
  .nullable();

export const ApiFeatureSchema = z
  .object({
    properties: z
      .object({ fill: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    geometry: ApiGeometrySchema.optional(),
  })
  .passthrough();

export type ApiFeature = z.infer<typeof ApiFeatureSchema>;

export const ApiFeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(ApiFeatureSchema),
});
