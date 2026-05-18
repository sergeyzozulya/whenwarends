import { z } from 'zod';

// Zod schema for the Polymarket Gamma API market response.
//
// Real endpoint (public, no auth):
//   GET https://gamma-api.polymarket.com/markets
//       ?closed=false&limit=100&order=volume&ascending=false
//       &tag=ukraine            (tag/slug filter narrows to the war markets)
//
// The Gamma API returns an array of market objects. Numeric fields (prices,
// liquidity, volume) come back as JSON strings, not numbers, so the schema
// coerces them. `outcomePrices` and `outcomes` arrive as JSON-encoded strings
// (e.g. "[\"0.62\", \"0.38\"]"), so we accept the raw string and decode it in
// the collector. We parse defensively: unknown extra fields are ignored, and
// the few fields the collector actually consumes are required.
//
// Per-market mid price for the binary "Yes" outcome is derived from
// `outcomePrices[0]` (Polymarket lists [Yes, No] for binary markets) and is
// already a 0–1 probability.

/** Polymarket serialises some numerics as strings; coerce them safely. */
const numericString = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a finite number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

const optionalNumericString = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

export const PolymarketMarketSchema = z.object({
  // Gamma uses a numeric id serialised as either number or string.
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  question: z.string().min(1),
  slug: z.string().optional(),
  // Resolution / close timestamps are ISO-8601 strings. `endDate` is the
  // canonical resolution date for Gamma markets; `closedTime` may also appear.
  endDate: z.string().optional(),
  closedTime: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  closed: z.boolean().optional(),
  active: z.boolean().optional(),
  // JSON-encoded string arrays, decoded in the collector.
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  liquidityNum: optionalNumericString,
  liquidity: optionalNumericString,
  volumeNum: optionalNumericString,
  volume: optionalNumericString,
  // Some Gamma responses expose a single best-bid/last price too.
  lastTradePrice: optionalNumericString,
  bestBid: optionalNumericString,
  bestAsk: optionalNumericString,
});

export type PolymarketMarket = z.infer<typeof PolymarketMarketSchema>;

/** Top-level response is an array of markets. */
export const PolymarketMarketsResponseSchema = z.array(PolymarketMarketSchema);

export type PolymarketMarketsResponse = z.infer<typeof PolymarketMarketsResponseSchema>;

/**
 * Decode a Polymarket JSON-encoded string array, e.g. `"[\"0.62\",\"0.38\"]"`
 * or `"[\"Yes\",\"No\"]"`. Returns [] on malformed input rather than throwing,
 * so one bad market never sinks the whole collector run.
 */
export function decodeJsonStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x));
  } catch {
    return [];
  }
}

// keep the coercion helper exported for unit testing of edge cases.
export { numericString };
