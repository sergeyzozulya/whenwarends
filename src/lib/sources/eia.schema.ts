import { z } from 'zod';

// Zod schema for the U.S. EIA Open Data API v2 — daily Brent crude spot price.
//
// Real endpoint (free API key required, no other auth):
//   GET https://api.eia.gov/v2/petroleum/pri/spt/data/
//         ?api_key=<KEY>&frequency=daily&data[0]=value
//         &facets[series][]=RBRTE&start=2022-01-01
//         &sort[0][column]=period&sort[0][direction]=asc&length=5000
//
//   RBRTE = "Europe Brent Spot Price FOB (Dollars per Barrel)", daily.
//
// Documented response shape (EIA Open Data v2):
//
//   {
//     "response": {
//       "total": 1100,
//       "dateFormat": "YYYY-MM-DD",
//       "frequency": "daily",
//       "data": [
//         {
//           "period": "2022-01-03",
//           "product": "EPCBRENT",
//           "product-name": "Crude Oil, Brent",
//           "process": "PF4",
//           "process-name": "Spot Price FOB",
//           "series": "RBRTE",
//           "series-description": "Europe Brent Spot Price FOB (Dollars per Barrel)",
//           "value": 78.98,
//           "units": "$/BBL"
//         },
//         ...
//       ]
//     },
//     "request": { ... },
//     "apiVersion": "2.x.x"
//   }
//
// We validate only the fields we consume (`period`, `value`); EIA may add or
// reorder the descriptive columns and that must not break parsing. `value` is
// accepted as number OR numeric string (EIA has been observed to return either
// across routes) and coerced/filtered in the collector — never fabricated.

/** One observation row. `value` may be a number, a numeric string, or null. */
export const EiaDataRowSchema = z
  .object({
    period: z.string(),
    value: z.union([z.number(), z.string()]).nullable(),
  })
  .passthrough();

export type EiaDataRow = z.infer<typeof EiaDataRowSchema>;

/** The `response` envelope. `data` is the only part we read. */
export const EiaResponseSchema = z.object({
  response: z.object({
    data: z.array(EiaDataRowSchema),
  }),
});

export type EiaResponse = z.infer<typeof EiaResponseSchema>;
