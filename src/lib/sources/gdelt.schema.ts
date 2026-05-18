import { z } from 'zod';

// GDELT DOC 2.0 API — Zod schema for the JSON timeline responses we consume.
//
// Real endpoints (CC BY 4.0, no auth required):
//
//   Conflict intensity / event density (article volume timeline):
//   https://api.gdeltproject.org/api/v2/doc/doc
//     ?query=(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng
//     &mode=timelinevol
//     &timespan=12m
//     &format=json
//
//   Conflict tone (average article tone timeline):
//   https://api.gdeltproject.org/api/v2/doc/doc
//     ?query=(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng
//     &mode=timelinetone
//     &timespan=12m
//     &format=json
//
// Both modes return the same envelope shape: a `timeline` array of series, each
// with a `data` array of { date, value } points. `timelinevol` reports the
// percentage of all monitored news that matched the query (a normalized
// conflict-intensity / event-density proxy). `timelinetone` reports the average
// Goldstein-style article tone (negative = more conflictual coverage).
//
// GDELT timeline dates are emitted as UTC. The live API (verified 2026-05-18)
// returns the compact ISO-ish form `YYYYMMDDTHHMMSSZ` (e.g. `20260517T204500Z`)
// at a 15-minute resolution. We also accept the bare `YYYYMMDDHHMMSS` and
// already-ISO variants and normalize to ISO-8601 UTC in the collector.
//
// Live response envelope (verified 2026-05-18, mode=timelinevol):
//
//   {
//     "query_details": { "title": "...", "date_resolution": "15m" },
//     "timeline": [
//       { "series": "Volume Intensity",
//         "data": [ { "date": "20260517T204500Z", "value": 0.9728 }, ... ] }
//     ]
//   }
//
// `timelinetone` is identical except series == "Average Tone" and values are
// signed tone scores. `query_details` is metadata we don't consume but accept.

export const GdeltTimelinePointSchema = z.object({
  // Live form: "20260517T204500Z". Also tolerate "20260517000000" and
  // already-ISO "2026-05-17T00:00:00Z". Normalized downstream; permissive here.
  date: z.string().min(1),
  value: z.number(),
});

export type GdeltTimelinePoint = z.infer<typeof GdeltTimelinePointSchema>;

export const GdeltTimelineSeriesSchema = z.object({
  series: z.string(),
  data: z.array(GdeltTimelinePointSchema),
});

export type GdeltTimelineSeries = z.infer<typeof GdeltTimelineSeriesSchema>;

export const GdeltQueryDetailsSchema = z.object({
  title: z.string().optional(),
  date_resolution: z.string().optional(),
});

export type GdeltQueryDetails = z.infer<typeof GdeltQueryDetailsSchema>;

export const GdeltTimelineResponseSchema = z.object({
  // Metadata GDELT echoes back; we accept but don't depend on it.
  query_details: GdeltQueryDetailsSchema.optional(),
  timeline: z.array(GdeltTimelineSeriesSchema),
});

export type GdeltTimelineResponse = z.infer<typeof GdeltTimelineResponseSchema>;
