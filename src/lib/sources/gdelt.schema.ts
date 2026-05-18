import { z } from 'zod';

// GDELT DOC 2.0 API — Zod schema for the JSON timeline responses we consume.
//
// Real endpoints (CC BY 4.0, no auth required):
//
//   Conflict intensity / event density (article volume timeline):
//   https://api.gdeltproject.org/api/v2/doc/doc
//     ?query=(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng
//     &mode=timelinevol
//     &timespan=12months
//     &format=json
//
//   Conflict tone (average article tone timeline):
//   https://api.gdeltproject.org/api/v2/doc/doc
//     ?query=(Ukraine OR Russia) (war OR military OR offensive OR ceasefire) sourcelang:eng
//     &mode=timelinetone
//     &timespan=12months
//     &format=json
//
// Both modes return the same envelope shape: a `timeline` array of series, each
// with a `data` array of { date, value } points. `timelinevol` reports the
// percentage of all monitored news that matched the query (a normalized
// conflict-intensity / event-density proxy). `timelinetone` reports the average
// Goldstein-style article tone (negative = more conflictual coverage).
//
// GDELT timeline dates are emitted as UTC, typically in the compact form
// `YYYYMMDDHHMMSS` (e.g. `20260517T120000Z` is also seen). We accept the
// observed variants here and normalize to ISO-8601 UTC in the collector.

export const GdeltTimelinePointSchema = z.object({
  // Examples seen in the wild: "20260517000000", "20260517T120000Z",
  // "2026-05-17T00:00:00Z". Normalized downstream; kept permissive here.
  date: z.string().min(1),
  value: z.number(),
});

export type GdeltTimelinePoint = z.infer<typeof GdeltTimelinePointSchema>;

export const GdeltTimelineSeriesSchema = z.object({
  series: z.string(),
  data: z.array(GdeltTimelinePointSchema),
});

export type GdeltTimelineSeries = z.infer<typeof GdeltTimelineSeriesSchema>;

export const GdeltTimelineResponseSchema = z.object({
  timeline: z.array(GdeltTimelineSeriesSchema),
});

export type GdeltTimelineResponse = z.infer<typeof GdeltTimelineResponseSchema>;
