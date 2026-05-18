import { z } from 'zod';

// Zod schema for the Russian Central Bank (CBR) daily exchange-rate JSON.
//
// Real endpoint (public mirror, no auth required, CORS-enabled, daily refresh):
//   GET https://www.cbr-xml-daily.ru/daily_json.js
//
// This is a community-maintained JSON mirror of the official CBR XML feed
// (https://www.cbr.ru/scripts/XML_daily.asp). It serves a stable JSON shape:
//
//   {
//     "Date": "2026-05-18T11:30:00+03:00",
//     "PreviousDate": "...",
//     "PreviousURL": "...",
//     "Timestamp": "2026-05-17T23:00:00+03:00",
//     "Valute": {
//       "USD": {
//         "ID": "R01235",
//         "NumCode": "840",
//         "CharCode": "USD",
//         "Nominal": 1,
//         "Name": "Доллар США",
//         "Value": 91.2345,
//         "Previous": 90.9876
//       },
//       ...
//     }
//   }
//
// `Value` is rubles per `Nominal` units of the foreign currency. For most
// currencies Nominal is 1, but some (e.g. JPY, KZT) quote per 10/100, so the
// RUB-per-unit rate is always `Value / Nominal`. We parse defensively: unknown
// extra fields are ignored, and only the fields the collector consumes are
// required.

/** One currency entry under `Valute`. */
export const CbrValuteEntrySchema = z.object({
  ID: z.string().optional(),
  NumCode: z.string().optional(),
  CharCode: z.string(),
  // CBR always sends a positive integer nominal; guard against 0/NaN so the
  // Value/Nominal division downstream can never produce Infinity/NaN.
  Nominal: z.number().int().positive(),
  Name: z.string().optional(),
  Value: z.number().finite(),
  Previous: z.number().finite().optional(),
});

export type CbrValuteEntry = z.infer<typeof CbrValuteEntrySchema>;

/** Top-level CBR daily payload. */
export const CbrDailySchema = z.object({
  // ISO-8601 with a Moscow (+03:00) offset; the collector normalises this to
  // canonical UTC ISO-8601 via `new Date(...).toISOString()`.
  Date: z.string().min(1),
  PreviousDate: z.string().optional(),
  PreviousURL: z.string().optional(),
  Timestamp: z.string().optional(),
  Valute: z.record(z.string(), CbrValuteEntrySchema),
});

export type CbrDaily = z.infer<typeof CbrDailySchema>;
