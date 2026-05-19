// Thin re-export so the scheduled cron runner picks up the Manifold
// collector. All logic lives in src/lib/sources/manifold.ts (independently
// unit-tested with a mocked fetch). Replaces the retired Kalshi source.

export { manifoldCollector, createManifoldCollector } from '../../lib/sources/manifold';
export type { JsonFetcher } from '../../lib/sources/manifold';
