import { z } from 'zod';

// Zod schema for CREA's Russia Fossil Tracker "counter" endpoint, aggregated to
// a daily cumulative series.
//
// Real endpoint (CREA, public, no auth):
//   GET https://api.russiafossiltracker.com/v0/counter
//         ?format=json&aggregate_by=date&cumulate=true
//         &date_from=2022-02-24&pricing_scenario=default
//
// Live-verified shape (2026-05-22): { "data": [ row, ... ] } where, with no
// commodity/destination breakdown requested, each row is the GRAND TOTAL for one
// day — already aggregated across all commodities and destinations, so there is
// nothing to sum and no "total" row to double-count. `cumulate=true` makes
// `value_eur` the running total of € paid to Russia from the invasion to that
// date. The latest row reconciles to CREA's headline (≈€1.07T, verified).
//   { "date": "2026-05-21T00:00:00", "value_eur": 1.071e12,
//     "value_tonne": ..., "value_usd": ... }
//
// We validate only `date` + `value_eur` and passthrough the rest.

export const CreaCounterPointSchema = z
  .object({
    date: z.string(),
    // Tolerate a null day so it can be skipped rather than failing the whole
    // array parse; the collector drops non-finite values.
    value_eur: z.number().nullable(),
  })
  .passthrough();

export type CreaCounterPoint = z.infer<typeof CreaCounterPointSchema>;

export const CreaCounterResponseSchema = z.object({
  data: z.array(CreaCounterPointSchema),
});

export type CreaCounterResponse = z.infer<typeof CreaCounterResponseSchema>;
