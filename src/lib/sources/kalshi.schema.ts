import { z } from 'zod';

// Kalshi public market data — Zod schema.
//
// Endpoint (public, NO auth):
//   GET https://external-api.kalshi.com/trade-api/v2/markets
//       ?series_ticker=<series>&status=open&limit=100&cursor=<cursor>
//
// LIVE-VERIFIED 2026-05-18 against external-api.kalshi.com (real payloads
// captured for both a multivariate market and the KXZELENSKYYOUT ladder).
//
// IMPORTANT: Kalshi restructured the API. The old integer-cents fields
// (`yes_bid`, `yes_ask`, `last_price` as 0..100 ints) are GONE. The current
// public feed returns prices as fixed-point DOLLAR STRINGS in [0,1], e.g.
// "0.1700" — already an implied YES probability, no /100 needed. Volume is a
// fixed-point COUNT STRING (`volume_fp`, e.g. "18139.17"); `liquidity_dollars`
// is deprecated and returns "0.0000". `latest_expiration_time` /
// `expiration_time` / `close_time` are ISO-8601 UTC. `title`/`subtitle` are
// deprecated; `yes_sub_title` is the human-readable strike label. There is no
// `category` field. Status is an enum string
// (initialized|inactive|active|closed|determined|disputed|amended|finalized);
// only "active" carries a live tradable quote.
//
// The schema is permissive on fields we do not consume (Kalshi adds fields
// over time) — no `.strict()` — but every field we read is strongly typed so
// a real contract drift fails loudly at the Zod boundary.

/**
 * Kalshi fixed-point money: a decimal string dollar amount in [0, 1] for
 * price fields (it IS the implied YES probability). We accept the string and
 * coerce to a bounded float. Reject anything outside [0,1] so the probability
 * invariant is enforced at the boundary.
 */
const DollarProbability = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a decimal dollar string')
  .transform((s) => Number(s))
  .pipe(z.number().min(0).max(1));

/**
 * Kalshi fixed-point count (e.g. volume): a non-negative decimal string. We
 * coerce to a float; it is only used as a rough liquidity proxy.
 */
const FixedPointCount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string')
  .transform((s) => Number(s))
  .pipe(z.number().nonnegative());

export const KalshiMarketSchema = z.object({
  ticker: z.string().min(1),
  event_ticker: z.string().optional(),
  // `title` is deprecated upstream but still populated; `yes_sub_title` is the
  // current human-readable strike label. We require at least `ticker` and use
  // whatever titling fields are present in the collector.
  title: z.string().optional(),
  subtitle: z.string().optional(),
  yes_sub_title: z.string().optional(),
  // Lifecycle enum. Only "active" carries a meaningful live price; we filter
  // downstream. Kept as a permissive string so a new enum member never breaks
  // ingest of the markets we do care about.
  status: z.string().min(1),
  // Implied YES probability signals, as fixed-point dollar strings in [0,1].
  yes_bid_dollars: DollarProbability.optional(),
  yes_ask_dollars: DollarProbability.optional(),
  last_price_dollars: DollarProbability.optional(),
  // ISO-8601 UTC timestamps.
  open_time: z.string().optional(),
  close_time: z.string().optional(),
  expiration_time: z.string().optional(),
  latest_expiration_time: z.string().optional(),
  expected_expiration_time: z.string().optional(),
  // Rough liquidity proxy. `liquidity_dollars` is deprecated ("0.0000") so we
  // prefer `volume_fp`. Both optional & defensive.
  volume_fp: FixedPointCount.optional(),
  volume_24h_fp: FixedPointCount.optional(),
  liquidity_dollars: FixedPointCount.optional(),
});

export type KalshiMarket = z.infer<typeof KalshiMarketSchema>;

/** Top-level shape of GET /trade-api/v2/markets. */
export const KalshiMarketsResponseSchema = z.object({
  markets: z.array(KalshiMarketSchema),
  // Empty string when there is no next page (Kalshi returns "" not absent).
  cursor: z.string().optional(),
});

export type KalshiMarketsResponse = z.infer<typeof KalshiMarketsResponseSchema>;
