// Thin re-export so the scheduled cron runner can pick up the Kalshi
// collector alongside the other sources. All logic lives in
// src/lib/sources/kalshi.ts (independently unit-tested with a mocked fetch).

export { kalshiCollector, collectKalshi } from '../../lib/sources/kalshi';
export type { JsonFetcher } from '../../lib/sources/kalshi';
