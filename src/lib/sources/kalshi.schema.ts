import { z } from 'zod';

// Kalshi public market data — Zod schema.
//
// Endpoint (public, no auth):
//   GET https://api.elections.kalshi.com/trade-api/v2/markets
//       ?series_ticker=<series>&status=open&limit=100
//
// The /markets endpoint returns a `markets` array. Each market carries an
// integer cents price (`yes_bid`, `yes_ask`, `last_price` — 0..100), a
// human-readable `title`/`subtitle`, an ISO-8601 UTC `close_time` /
// `expiration_time`, and a stable `ticker`. Prices are cents-of-a-dollar,
// i.e. an implied probability of the YES outcome; we normalise to a 0–1
// float in the collector. `volume` / `liquidity` (also integer cents/units)
// give a rough liquidity signal.
//
// We intentionally keep this schema permissive on fields we do not consume
// (Kalshi adds fields over time) by not using `.strict()`, but we strongly
// type every field we read so a contract drift fails loudly at the boundary.

/** Kalshi prices are integer cents (0–100). Allow the full inclusive range. */
const CentsPrice = z.number().int().min(0).max(100);

export const KalshiMarketSchema = z.object({
  ticker: z.string().min(1),
  // `event_ticker` / `series_ticker` are present on most responses but the
  // public markets feed occasionally omits them on legacy markets.
  event_ticker: z.string().optional(),
  series_ticker: z.string().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  // Lifecycle: only "active"/"open" markets carry a meaningful live price.
  status: z.string(),
  // Implied YES probability signals, in integer cents.
  yes_bid: CentsPrice.optional(),
  yes_ask: CentsPrice.optional(),
  last_price: CentsPrice.optional(),
  // ISO-8601 UTC timestamps.
  open_time: z.string().optional(),
  close_time: z.string(),
  expiration_time: z.string().optional(),
  // Rough liquidity proxies (integer units/cents). Optional & defensive.
  volume: z.number().nonnegative().optional(),
  liquidity: z.number().nonnegative().optional(),
  category: z.string().optional(),
});

export type KalshiMarket = z.infer<typeof KalshiMarketSchema>;

/** Top-level shape of GET /trade-api/v2/markets. */
export const KalshiMarketsResponseSchema = z.object({
  markets: z.array(KalshiMarketSchema),
  cursor: z.string().optional(),
});

export type KalshiMarketsResponse = z.infer<typeof KalshiMarketsResponseSchema>;
