// Manifold Markets collector — secondary war-end market source (SPEC §8.1).
//
// Discovers a SET of open binary Russia–Ukraine ceasefire/peace markets via the
// public search API, filtered by the SAME shared war-end conditions as
// Polymarket (warEndFilter.ts), and returns them as MarketRow[] for the hero
// chart + per-market history. Manifold is play money: liquidity is in mana
// (liquidity_mana), and the cross-source weighting normalises per source so it
// counts equally with real-money Polymarket (SPEC §8.3).
//
// No auth, no key. Per-market price history is appended by the collect runner
// (one market_price snapshot per market per run); this collector returns only
// current market state.

import type { Collector, CollectorResult, Env, MarketRow } from '../types';
import { fetchJson } from './contract';
import {
  ManifoldSearchResponseSchema,
  type ManifoldSearchMarket,
} from './manifold.schema';
import { isWarEndMarket, deriveResolutionDate } from './warEndFilter';

export const MANIFOLD_SOURCE = 'manifold';

const API = 'https://api.manifold.markets/v0';
/** Search terms cast a wide net; the shared filter then keeps only war-end. */
const SEARCH_TERMS = [
  'Russia Ukraine ceasefire',
  'Ukraine war end',
  'Russia Ukraine peace deal',
];
const PER_TERM_LIMIT = 25;

export class ManifoldSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifoldSourceError';
  }
}

export type JsonFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: JsonFetcher = (url) => fetchJson(url);

export interface ManifoldFetchers {
  fetchJson: JsonFetcher;
}
const defaults: ManifoldFetchers = { fetchJson: defaultFetcher };

function searchUrl(term: string): string {
  return (
    `${API}/search-markets?term=${encodeURIComponent(term)}` +
    `&filter=open&contractType=BINARY&limit=${PER_TERM_LIMIT}&sort=most-popular`
  );
}

const manaLiquidity = (m: ManifoldSearchMarket): number | null => {
  const l = m.totalLiquidity;
  return typeof l === 'number' && Number.isFinite(l) && l > 0 ? l : null;
};

/**
 * Map already-fetched Manifold search results to war-end MarketRow[]. Pure, so
 * tests exercise it without the network. Dedupes by id; keeps only open binary
 * markets that pass the shared war-end filter and clear the liquidity floor.
 */
export function mapManifoldMarkets(
  results: ManifoldSearchMarket[][],
  nowIso: string
): MarketRow[] {
  const seen = new Set<string>();
  const rows: MarketRow[] = [];

  for (const list of results) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      if (m.isResolved === true) continue;
      if (m.outcomeType && m.outcomeType !== 'BINARY') continue;
      if (typeof m.probability !== 'number' || !Number.isFinite(m.probability))
        continue;
      if (!isWarEndMarket(m.question)) continue;
      const liq = manaLiquidity(m);
      if (liq === null) continue; // no liquidity ⇒ dead market; quality floor applied downstream
      seen.add(m.id);
      const resolution = deriveResolutionDate(m.question, {
        closeIso:
          typeof m.closeTime === 'number'
            ? new Date(m.closeTime).toISOString()
            : null,
        fallbackIso: nowIso,
      });

      rows.push({
        market_id: `${MANIFOLD_SOURCE}:${m.id}`,
        source: MANIFOLD_SOURCE,
        question: m.question,
        resolution_date: resolution,
        category: 'war_end',
        current_price: Math.min(1, Math.max(0, m.probability)),
        liquidity_usd: null,
        liquidity_mana: liq,
        last_updated: nowIso,
      });
    }
  }
  return rows;
}

export function createManifoldCollector(
  fetchers: ManifoldFetchers = defaults
): Collector {
  return {
    name: MANIFOLD_SOURCE,
    async run(_env: Env): Promise<CollectorResult> {
      const lists: ManifoldSearchMarket[][] = [];
      for (const term of SEARCH_TERMS) {
        try {
          lists.push(
            ManifoldSearchResponseSchema.parse(
              await fetchers.fetchJson(searchUrl(term))
            )
          );
        } catch {
          // One failed search term shouldn't sink the source; keep the rest.
        }
      }
      if (lists.length === 0) {
        throw new ManifoldSourceError('Manifold search returned nothing usable');
      }
      const markets = mapManifoldMarkets(lists, new Date().toISOString());
      return { snapshots: [], markets };
    },
  };
}

export const manifoldCollector: Collector = createManifoldCollector();
