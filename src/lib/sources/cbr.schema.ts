import { z } from 'zod';

// Zod schema for the Russian Central Bank (CBR) daily exchange-rate feed.
//
// Real, durable endpoint (official CBR, no auth, daily refresh):
//   GET https://www.cbr.ru/scripts/XML_daily.asp
//
// We deliberately use the OFFICIAL CBR source rather than the community JSON
// mirror cbr-xml-daily.ru: that mirror is unstable and was observed fully
// unreachable (DNS/connection failure) from this environment, which is the
// original "fetch failed" bug. The official host is stable but:
//   - serves XML (not JSON), encoded in windows-1251,
//   - requires a User-Agent header (plain fetch is otherwise blocked),
//   - uses a comma as the decimal separator and DD.MM.YYYY for the date.
//
// Real captured response (truncated), 16 May 2026:
//
//   <?xml version="1.0" encoding="windows-1251"?>
//   <ValCurs Date="16.05.2026" name="Foreign Currency Market">
//     <Valute ID="R01235">
//       <NumCode>840</NumCode>
//       <CharCode>USD</CharCode>
//       <Nominal>1</Nominal>
//       <Name>Доллар США</Name>
//       <Value>73,1275</Value>
//       <VunitRate>73,1275</VunitRate>
//     </Valute>
//     ...
//   </ValCurs>
//
// The collector parses the (flat, namespace-free, CDATA-free) XML defensively
// with a scoped regex, normalises the comma decimals / DD.MM.YYYY date, and
// hands the EXTRACTED, already-normalised fields to the schema below. So this
// schema validates the post-extraction shape, not raw XML text.
//
// `Value` is rubles per `Nominal` units of the foreign currency (Nominal is 1
// for USD today, but other currencies quote per 10/100), so RUB-per-unit is
// always `Value / Nominal`.

/** The USD entry extracted from the `<Valute>` block, post-normalisation. */
export const CbrUsdEntrySchema = z.object({
  CharCode: z.literal('USD'),
  // CBR always sends a positive integer nominal; guard against 0/NaN so the
  // Value/Nominal division downstream can never produce Infinity/NaN.
  Nominal: z.number().int().positive(),
  // Already normalised from "73,1275" to a JS number by the extractor; reject
  // anything non-finite (e.g. a failed comma→dot conversion yielding NaN).
  Value: z.number().finite(),
});

export type CbrUsdEntry = z.infer<typeof CbrUsdEntrySchema>;

/** The whole extracted payload the collector consumes. */
export const CbrDailySchema = z.object({
  // CBR `Date` attribute is a Moscow calendar date in DD.MM.YYYY form; the
  // extractor converts it to canonical UTC ISO-8601 before this validates it.
  DateIso: z.string().datetime(),
  USD: CbrUsdEntrySchema,
});

export type CbrDaily = z.infer<typeof CbrDailySchema>;
