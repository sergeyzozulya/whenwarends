import { z } from 'zod';

// Manifold Markets API — Zod schemas for the endpoints we consume.
//
// Real endpoints (public, no auth, free):
//   GET https://api.manifold.markets/v0/search-markets?term=<q>&filter=open&contractType=BINARY&limit=<n>&sort=<s>
//   GET https://api.manifold.markets/v0/market/<id>
//   GET https://api.manifold.markets/v0/bets?contractId=<id>&limit=1000[&before=<betId>]
//
// `probability` / `probAfter` are 0–1. Times are epoch MILLISECONDS.
// `totalLiquidity` / `volume` are in mana (play money). Manifold is a
// play-money community market. Extra fields are ignored (passthrough).

/** One market from /v0/search-markets (a "LiteMarket"). */
export const ManifoldSearchMarketSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    outcomeType: z.string().optional(),
    probability: z.number().optional(),
    closeTime: z.number().optional(), // epoch ms
    isResolved: z.boolean().optional(),
    totalLiquidity: z.number().optional(), // mana
    volume: z.number().optional(), // mana
  })
  .passthrough();

export type ManifoldSearchMarket = z.infer<typeof ManifoldSearchMarketSchema>;

export const ManifoldSearchResponseSchema = z.array(ManifoldSearchMarketSchema);

export const ManifoldMarketSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    outcomeType: z.string().optional(),
    probability: z.number(),
    createdTime: z.number(),
    isResolved: z.boolean().optional(),
  })
  .passthrough();

export type ManifoldMarket = z.infer<typeof ManifoldMarketSchema>;

export const ManifoldBetSchema = z
  .object({
    id: z.string(),
    createdTime: z.number(),
    // Redemption/cancel bets can omit probAfter; those rows are skipped.
    probAfter: z.number().optional(),
  })
  .passthrough();

export type ManifoldBet = z.infer<typeof ManifoldBetSchema>;

export const ManifoldBetsSchema = z.array(ManifoldBetSchema);
