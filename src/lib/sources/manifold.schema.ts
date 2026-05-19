import { z } from 'zod';

// Manifold Markets API — Zod schemas for the two endpoints we consume.
//
// Real endpoints (public, no auth, free):
//   GET https://api.manifold.markets/v0/market/<id>
//   GET https://api.manifold.markets/v0/bets?contractId=<id>&limit=1000[&before=<betId>]
//
// `probability` / `probAfter` are 0–1. Times are epoch MILLISECONDS. Manifold
// is a play-money community market, so we treat it as a lower-confidence
// forecast signal than the real-money Polymarket. Extra fields are ignored.

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
