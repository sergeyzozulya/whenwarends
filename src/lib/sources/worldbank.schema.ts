import { z } from 'zod';

// Zod schema for the World Bank Indicators API v2 JSON response.
//
// Real endpoint (public, no auth, no key required):
//   GET https://api.worldbank.org/v2/country/RUS/indicator/<CODE>?format=json
//       &per_page=100
//
//   e.g. https://api.worldbank.org/v2/country/RUS/indicator/NY.GDP.MKTP.KD.ZG?format=json
//
// The response is a TWO-ELEMENT array: a tuple of [meta, datapoints[]].
//   [0] meta object   — { page, pages, per_page, total, sourceid, lastupdated }
//   [1] datapoints[]   — array of yearly observations, newest year first.
//
// Each datapoint:
//   {
//     "indicator":   { "id": "NY.GDP.MKTP.KD.ZG", "value": "GDP growth (annual %)" },
//     "country":     { "id": "RU", "value": "Russian Federation" },
//     "countryiso3code": "RUS",
//     "date":  "2023",          // calendar year as a string
//     "value": -1.234,          // numeric; null when no observation for the year
//     "unit":  "",
//     "obs_status": "",
//     "decimal": 1
//   }
//
// When the API has no data for the country/indicator pair it still returns a
// 2-element array but the second element is `null` (not []). The schema models
// that explicitly. We parse defensively: unknown extra fields are ignored.

/** A single yearly observation. `value` is null when the year has no data. */
export const WorldBankDatapointSchema = z.object({
  indicator: z.object({
    id: z.string(),
    value: z.string().nullable().optional(),
  }),
  country: z.object({
    id: z.string(),
    value: z.string().nullable().optional(),
  }),
  countryiso3code: z.string().optional(),
  // World Bank annual series use a 4-digit calendar year as a string.
  date: z.string(),
  value: z.number().nullable(),
  unit: z.string().optional(),
  obs_status: z.string().optional(),
  decimal: z.number().optional(),
});

export type WorldBankDatapoint = z.infer<typeof WorldBankDatapointSchema>;

/** Pagination / source metadata (element [0]). Only fields we may use. */
export const WorldBankMetaSchema = z.object({
  page: z.number().optional(),
  pages: z.number().optional(),
  per_page: z.union([z.number(), z.string()]).optional(),
  total: z.number().optional(),
  sourceid: z.union([z.number(), z.string()]).nullable().optional(),
  lastupdated: z.string().optional(),
});

export type WorldBankMeta = z.infer<typeof WorldBankMetaSchema>;

/**
 * Top-level response: a fixed 2-tuple [meta, datapoints | null].
 * The data element is `null` when the API has no series for the request.
 */
export const WorldBankResponseSchema = z.tuple([
  WorldBankMetaSchema,
  z.array(WorldBankDatapointSchema).nullable(),
]);

export type WorldBankResponse = z.infer<typeof WorldBankResponseSchema>;
