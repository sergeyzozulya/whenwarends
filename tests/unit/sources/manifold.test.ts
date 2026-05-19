import { describe, it, expect } from 'vitest';
import {
  createManifoldCollector,
  ManifoldSourceError,
  MANIFOLD_SOURCE,
  WAR_END_METRIC,
  DEFAULT_MARKET_ID,
  type ManifoldFetchers,
} from '../../../src/lib/sources/manifold';
import type { Env } from '../../../src/lib/types';

const env = {} as Env;
const DAY = 86_400_000;
const market = {
  id: DEFAULT_MARKET_ID,
  question: 'Russia–Ukraine ceasefire?',
  outcomeType: 'BINARY',
  probability: 0.42,
  createdTime: 1_690_000_000_000,
  isResolved: false,
};

// Two same-day bets (keep the later one) + one a day earlier.
const t0 = Date.UTC(2025, 0, 10, 9);
const t0b = Date.UTC(2025, 0, 10, 18);
const tm1 = Date.UTC(2025, 0, 9, 12);
const betsPage = [
  { id: 'b3', createdTime: t0b, probAfter: 0.30 },
  { id: 'b2', createdTime: t0, probAfter: 0.25 },
  { id: 'b1', createdTime: tm1, probAfter: 0.20 },
];

function fetchersFor(
  marketObj: unknown,
  pages: Record<string, unknown>
): ManifoldFetchers {
  return {
    fetchJson: async (url: string) => {
      if (url.includes('/market/')) return marketObj;
      if (url.includes('/bets?')) {
        const m = /before=([^&]+)/.exec(url);
        return pages[m ? m[1] : 'first'] ?? [];
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

describe('manifold collector', () => {
  it('downsamples bet history to one closing probability per UTC day', async () => {
    const c = createManifoldCollector(
      fetchersFor(market, { first: betsPage })
    );
    const { snapshots } = await c.run(env);

    expect(snapshots.every((s) => s.metric === WAR_END_METRIC)).toBe(true);
    expect(snapshots.every((s) => s.source === MANIFOLD_SOURCE)).toBe(true);

    const jan9 = snapshots.find((s) => s.ts === '2025-01-09T00:00:00.000Z');
    const jan10 = snapshots.find((s) => s.ts === '2025-01-10T00:00:00.000Z');
    expect(jan9?.value).toBe(0.2);
    expect(jan10?.value).toBe(0.3); // later same-day bet wins, not 0.25
    // Ascending by ts.
    const ts = snapshots.map((s) => s.ts);
    expect([...ts]).toEqual([...ts].sort());
  });

  it("today's point reflects the live market probability", async () => {
    const c = createManifoldCollector(
      fetchersFor(market, { first: betsPage })
    );
    const { snapshots } = await c.run(env);
    const today = new Date().toISOString().slice(0, 10);
    const t = snapshots.find((s) => s.ts === `${today}T00:00:00.000Z`);
    expect(t?.value).toBe(0.42); // == market.probability
  });

  it('pages the bet history with the before cursor', async () => {
    const seen: string[] = [];
    const fetchers: ManifoldFetchers = {
      fetchJson: async (url: string) => {
        if (url.includes('/market/')) return market;
        seen.push(url);
        if (!url.includes('before=')) {
          // full page → triggers a second request with before=<lastId>
          return Array.from({ length: 1000 }, (_, i) => ({
            id: `p1-${i}`,
            createdTime: tm1 - i * DAY,
            probAfter: 0.2,
          }));
        }
        return []; // second page empty → stop
      },
    };
    await createManifoldCollector(fetchers).run(env);
    expect(seen.some((u) => u.includes('before=p1-999'))).toBe(true);
  });

  it('throws a typed error when the market is unavailable', async () => {
    const c = createManifoldCollector({
      fetchJson: async () => {
        throw new Error('404');
      },
    });
    await expect(c.run(env)).rejects.toBeInstanceOf(ManifoldSourceError);
  });

  it('skips bets without a numeric probAfter, never fabricating', async () => {
    const c = createManifoldCollector(
      fetchersFor(market, {
        first: [
          { id: 'x1', createdTime: tm1, probAfter: 0.2 },
          { id: 'x2', createdTime: t0 }, // redemption, no probAfter
        ],
      })
    );
    const { snapshots } = await c.run(env);
    // jan9 from x1, plus today's live point — x2 contributed nothing.
    expect(
      snapshots.find((s) => s.ts === '2025-01-09T00:00:00.000Z')?.value
    ).toBe(0.2);
  });
});
