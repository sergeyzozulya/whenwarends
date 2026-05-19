// Manifold Markets collector — community-forecast war-end probability.
//
// Replaces Kalshi (whose public data needed a series ticker and gave little
// war-relevant history). Manifold is free, no auth, and exposes full per-bet
// probability history via /v0/bets, so we can reconstruct the daily
// probability series back to the market's creation.
//
// HONEST LIMIT: a Manifold market is a time-bounded question, so history can
// only go back to when that market was *created* — not necessarily 24 Feb
// 2022. We emit the full real history we can get and never fabricate earlier
// points. The operator can point MANIFOLD_MARKET_ID at a longer-lived market.
//
// metric 'war_end_probability', source 'manifold'. One snapshot per UTC day
// = that day's closing probability (the latest bet's probAfter), so the
// series is daily, not thousands of per-bet points.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import { fetchJson } from './contract';
import {
  ManifoldMarketSchema,
  ManifoldBetsSchema,
} from './manifold.schema';

export const MANIFOLD_SOURCE = 'manifold';
export const WAR_END_METRIC = 'war_end_probability';
// Longest-lived OPEN binary "Russia–Ukraine ceasefire" market at time of
// writing (created 2023-09). Operator config, like KIEL_DATASET_URL.
export const DEFAULT_MARKET_ID = 'DxJpflB1KwrKx5xk5hSn';
const API = 'https://api.manifold.markets/v0';
const PAGE = 1000;
const MAX_PAGES = 60; // safety cap (60k bets); daily-downsampled anyway

export class ManifoldSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifoldSourceError';
  }
}

export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

function resolveMarketId(env: Env): string {
  const v = (env as unknown as { MANIFOLD_MARKET_ID?: unknown })
    .MANIFOLD_MARKET_ID;
  return typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : DEFAULT_MARKET_ID;
}

const dayIso = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

export interface ManifoldFetchers {
  fetchJson: JsonFetcher;
}
const defaults: ManifoldFetchers = { fetchJson: defaultFetcher };

export function createManifoldCollector(
  fetchers: ManifoldFetchers = defaults
): Collector {
  return {
    name: MANIFOLD_SOURCE,
    async run(env: Env): Promise<CollectorResult> {
      const id = resolveMarketId(env);

      let market;
      try {
        market = ManifoldMarketSchema.parse(
          await fetchers.fetchJson(`${API}/market/${id}`)
        );
      } catch (err) {
        throw new ManifoldSourceError(
          `Manifold market ${id} unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // Page the full bet history (newest-first; cursor = last bet id).
      // A failed page stops paging but keeps what we have — partial real
      // history beats none, and never fabricated.
      const byDay = new Map<string, { t: number; p: number }>();
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url =
          `${API}/bets?contractId=${id}&limit=${PAGE}` +
          (before ? `&before=${before}` : '');
        let bets;
        try {
          bets = ManifoldBetsSchema.parse(await fetchers.fetchJson(url));
        } catch {
          break;
        }
        if (bets.length === 0) break;
        for (const b of bets) {
          if (typeof b.probAfter !== 'number' || !Number.isFinite(b.probAfter))
            continue;
          const key = dayIso(b.createdTime);
          const cur = byDay.get(key);
          if (!cur || b.createdTime > cur.t) {
            byDay.set(key, { t: b.createdTime, p: b.probAfter });
          }
        }
        before = bets[bets.length - 1].id;
        if (bets.length < PAGE) break;
      }

      // Ensure today's point reflects the live market probability.
      const todayKey = dayIso(Date.now());
      byDay.set(todayKey, { t: Date.now(), p: market.probability });

      const snapshots: SnapshotInput[] = [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ts, { p }]) => ({
          metric: WAR_END_METRIC,
          source: MANIFOLD_SOURCE,
          ts,
          value: p,
          raw_blob: JSON.stringify({ marketId: id, question: market.question }),
          // Play-money community market — a real but lower-confidence signal
          // than real-money Polymarket.
          confidence: 0.8,
        }));

      if (snapshots.length === 0) {
        throw new ManifoldSourceError(
          `Manifold market ${id} produced no usable probability points`
        );
      }
      return { snapshots };
    },
  };
}

export const manifoldCollector: Collector = createManifoldCollector();
