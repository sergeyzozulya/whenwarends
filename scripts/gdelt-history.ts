// One-time GDELT historical backfill. Walks yearly windows war-start→now for
// conflict_intensity + conflict_tone and appends to the snapshot store.
//
// SEPARATE from the weekly collect on purpose: history is immutable, GDELT
// rate-limits hard (1 req/5s, "contact … for larger queries"), and cramming
// ~10 windowed requests into every weekly run is exactly what got the
// collector rate-limited and failing. Run this ONCE, manually, from a
// non-rate-limited IP. Resilient (per-window skip) + idempotent
// (appendSnapshots dedupes on (metric,source,ts)), so it is safe to re-run
// to fill windows a prior run skipped.
//
// Usage: npm run collect:gdelt-history

import { collectGdeltHistory } from '../src/lib/sources/gdelt';
import { appendSnapshots } from '../src/lib/filestore';

async function main(): Promise<void> {
  const { snapshots } = await collectGdeltHistory();
  const added = appendSnapshots(snapshots);
  const months = new Set(snapshots.map((s) => s.ts.slice(0, 7)));
  console.log(
    `gdelt-history: ${snapshots.length} points over ${months.size} months; ` +
      `${added} new appended` +
      `${added < snapshots.length ? ` (${snapshots.length - added} already present)` : ''}.`
  );
  if (snapshots.length === 0) {
    console.error('no GDELT history collected (all windows failed?)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
