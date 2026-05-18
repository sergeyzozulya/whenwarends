import { z } from 'zod';

// Zod schema for the Polymarket Gamma API EVENTS response.
//
// Real endpoint (public, no auth, no key — verified live 2026-05-18):
//   GET https://gamma-api.polymarket.com/events
//       ?closed=false&active=true&limit=100&order=volume&ascending=false
//       &tag_slug=ukraine
//
//   IMPORTANT findings from the live API:
//   - The `tag` query param on /markets is IGNORED (returns unrelated markets).
//     Tag filtering only works on /events via `tag_slug`. So we query /events
//     and walk the nested `markets[]` array of each event.
//   - Numeric fields (liquidity, volume, prices) are returned as JSON STRINGS
//     for the string-typed fields and as real numbers for the *Num fields
//     (liquidityNum, volumeNum) and the order-book fields (bestBid/bestAsk/
//     lastTradePrice). The schema coerces both forms.
//   - `outcomes` and `outcomePrices` are JSON-ENCODED strings inside the JSON,
//     e.g. "[\"Yes\", \"No\"]" and "[\"0.505\", \"0.495\"]". We keep them as
//     raw strings here and decode them in the collector.
//   - Grouped markets (e.g. "Russia x Ukraine ceasefire agreement by...?")
//     share ONE event-level `endDate` across every sub-market. The real
//     per-market resolution date lives in the question text ("by December 31,
//     2026?") and partially in `groupItemTitle` ("December 31", no year). The
//     collector derives the true resolution date from those; `endDate` /
//     `endDateIso` are only a last-resort fallback.
//
// We parse defensively: unknown extra fields are ignored, and only the few
// fields the collector consumes are required.

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
  .nullish()
  .transform((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const optionalIsoString = z
  .string()
  .nullish()
  .transform((v) => (v === undefined || v === null || v === '' ? undefined : v));

export const PolymarketMarketSchema = z.object({
  // Gamma uses a numeric id serialised as either number or string.
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  question: z.string().min(1),
  slug: z.string().optional(),
  // For grouped markets this is the per-row label (e.g. "December 31") with
  // NO year — useful only combined with a year inferred elsewhere.
  groupItemTitle: z.string().nullish().transform((v) => v ?? undefined),
  // Resolution / close timestamps. For grouped markets `endDate` is the shared
  // event close, NOT the per-market resolution — see collector for the real
  // date derivation. `endDateIso` is a date-only "YYYY-MM-DD" string.
  endDate: optionalIsoString,
  endDateIso: optionalIsoString,
  closedTime: optionalIsoString,
  createdAt: optionalIsoString,
  updatedAt: optionalIsoString,
  closed: z.boolean().optional(),
  active: z.boolean().optional(),
  // JSON-encoded string arrays, decoded in the collector.
  outcomes: z.string().optional(),
  outcomePrices: z.string().optional(),
  liquidityNum: optionalNumericString,
  liquidity: optionalNumericString,
  volumeNum: optionalNumericString,
  volume: optionalNumericString,
  // Order-book derived prices (real numbers in the live API).
  lastTradePrice: optionalNumericString,
  bestBid: optionalNumericString,
  bestAsk: optionalNumericString,
});

export type PolymarketMarket = z.infer<typeof PolymarketMarketSchema>;

/**
 * An event groups one or more markets. We filter at the market level, so the
 * only event field we need is the nested `markets` array; everything else is
 * tolerated and ignored. `markets` is optional/nullable on the wire for empty
 * or still-deploying events.
 */
export const PolymarketEventSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)).optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  closed: z.boolean().optional(),
  active: z.boolean().optional(),
  markets: z.array(PolymarketMarketSchema).nullish().transform((v) => v ?? []),
});

export type PolymarketEvent = z.infer<typeof PolymarketEventSchema>;

/** Top-level /events response is an array of events. */
export const PolymarketEventsResponseSchema = z.array(PolymarketEventSchema);

export type PolymarketEventsResponse = z.infer<typeof PolymarketEventsResponseSchema>;

/**
 * Decode a Polymarket JSON-encoded string array, e.g. `"[\"0.505\",\"0.495\"]"`
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
