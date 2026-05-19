import { z } from 'zod';

// Zod schema for the National Bank of Ukraine price-index dataset.
//
// Real endpoint (public, no auth required):
//   GET https://bank.gov.ua/NBUStatService/v1/statdirectory/inflation
//       ?json&period=m&date=YYYYMM
//
// One `date=YYYYMM` request returns EVERY series for that single month — three
// datasets (CPI, core inflation, PPI) × COICOP division × region × measure.
// Each row:
//   {
//     "dt": "20231201",                 // YYYYMMDD, first of the month
//     "txten": "Consumer price indices ",
//     "id_api": "prices_price_cpi_",     // dataset selector (cpi | ci | ppi)
//     "freq": "M",
//     "mcrd081": "Total",                // COICOP division; "Total" = all items
//     "ku": null,                        // region code; null = national total
//     "mcrk110": "NULL",                 // sub-aggregate; "NULL" = headline
//     "tzep": "PCCM_",                   // measure; PCCM_ = % vs same month a
//                                        //          year earlier (y/y)
//     "value": 5.1                       // the figure (percent), nullable
//   }
//
// The national headline CPI inflation (% y/y) is the UNIQUE row with
//   id_api="prices_price_cpi_" AND mcrd081="Total" AND ku=null AND
//   mcrk110="NULL" AND tzep="PCCM_" AND freq="M".
// Verified by reconstructing the full 2022→now trajectory and matching it to
// Ukraine's official series (10.0% Jan-22 → 26.6% peak Nov-22 → 5.1% Dec-23).
//
// Parsed defensively: only the fields the collector consumes are required;
// unknown extra fields are ignored. `ku` is genuinely `null` for the national
// row (not the string "NULL", which is what `mcrk110` uses).

export const NbuCpiRowSchema = z.object({
  dt: z.string(),
  id_api: z.string(),
  freq: z.string(),
  mcrd081: z.string().nullable(),
  ku: z.string().nullable(),
  mcrk110: z.string().nullable(),
  tzep: z.string(),
  value: z.number().nullable(),
});

export type NbuCpiRow = z.infer<typeof NbuCpiRowSchema>;

/** Top-level response is a flat array of rows. */
export const NbuCpiResponseSchema = z.array(NbuCpiRowSchema);

export type NbuCpiResponse = z.infer<typeof NbuCpiResponseSchema>;
