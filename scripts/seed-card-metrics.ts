// One-shot, offline seed for the per-card trend metrics. Computes the two stat
// cards from the CURRENT data/markets.json (no live API calls) and appends one
// snapshot each. Idempotent: appendSnapshots dedupes on (metric, source, ts),
// so re-running only adds a point when markets have since changed.
//
// Run: `npm run seed-card-metrics`. Going forward the weekly `npm run collect`
// adds these snapshots automatically; this just bootstraps the first point so
// the cards have a datum before the next collect.

import { readMarkets, appendSnapshots } from '../src/lib/filestore';
import { allDerivedSnapshots } from '../src/lib/cards';

const added = appendSnapshots(
  allDerivedSnapshots(readMarkets(), new Date().toISOString())
);
console.log(`seeded ${added} derived snapshot(s)`);
