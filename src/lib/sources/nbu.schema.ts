import { z } from 'zod';

// Zod schema for the National Bank of Ukraine (NBU) official exchange rate API.
//
// Real endpoint (public, no auth required):
//   GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json
//
// Returns a JSON array of per-currency rate objects, e.g.:
//   [
//     { "r030": 840, "txt": "Долар США", "rate": 41.5023,
//       "cc": "USD", "exchangedate": "16.05.2026" },
//     { "r030": 978, "txt": "Євро", "rate": 46.1187,
//       "cc": "EUR", "exchangedate": "16.05.2026" },
//     ...
//   ]
//
// Field notes:
//   r030          ISO-4217 numeric currency code (840 = USD).
//   txt           Localized (Ukrainian) currency name. Not consumed downstream.
//   rate          UAH per one unit of the currency (the official NBU rate).
//   cc            ISO-4217 alpha code (e.g. "USD"). Used to select USD.
//   exchangedate  Rate date in dd.mm.yyyy form (Kyiv-published, treated as the
//                 UTC calendar date). Converted to ISO-8601 UTC in the collector.
//
// This statdirectory endpoint exposes FX rates only; it carries no reserves
// figures, so the collector emits the UAH/USD rate metric only.
//
// Parsed defensively: unknown extra fields are ignored, and only the fields the
// collector actually consumes are required.

export const NbuRateSchema = z.object({
  r030: z.number(),
  txt: z.string(),
  rate: z.number(),
  cc: z.string(),
  exchangedate: z.string(),
});

export type NbuRate = z.infer<typeof NbuRateSchema>;

/** Top-level response is an array of currency rate objects. */
export const NbuExchangeResponseSchema = z.array(NbuRateSchema);

export type NbuExchangeResponse = z.infer<typeof NbuExchangeResponseSchema>;
