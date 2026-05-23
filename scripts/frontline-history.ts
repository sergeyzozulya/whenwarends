// One-time DeepState front-line history backfill. Seeds the occupied-area
// (occupied_area_km2) series two ways, then the daily collect keeps it fresh:
//
//   • MONTHLY pre-mirror history from DeepState's own API (~Sept 2022 →
//     mid-2024) — extends the line back past where the mirror starts.
//   • DAILY history from the cyterat mirror (2024-07-08 → now).
//
// SEPARATE from the daily collect on purpose (many requests). Resilient
// (per-month/day skip on error) + idempotent (appendSnapshots dedupes on
// (metric,source,ts)), so it is safe to re-run.
//
// Licensing: only the derived km² FACT is stored, never the geometry (see
// CLAUDE.md "Licensing" + src/lib/sources/deepstate.ts).
//
// Usage: npm run collect:frontline-history

import {
  collectDeepStateHistory,
  collectDeepStateMonthlyHistory,
} from '../src/lib/sources/deepstate';
import { appendSnapshots } from '../src/lib/filestore';
import { isEntrypoint } from './isEntrypoint';

export async function runFrontlineHistory(): Promise<void> {
  // Monthly pre-mirror history (DeepState API), late 2022 → mid-2024.
  let monthly = 0;
  try {
    const res = await collectDeepStateMonthlyHistory();
    monthly = res.snapshots.length;
    const added = appendSnapshots(res.snapshots);
    console.log(`  monthly (API): ${monthly} points; ${added} new appended.`);
  } catch (err) {
    console.error(
      `  monthly (API) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Daily history (cyterat mirror), 2024-07-08 → now.
  let daily = 0;
  try {
    const res = await collectDeepStateHistory();
    daily = res.snapshots.length;
    const added = appendSnapshots(res.snapshots);
    console.log(`  daily (mirror): ${daily} points; ${added} new appended.`);
  } catch (err) {
    console.error(
      `  daily (mirror) failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  console.log(`frontline-history: ${monthly} monthly + ${daily} daily points.`);
  if (monthly + daily === 0) {
    console.error('no DeepState history collected (network blocked?)');
    process.exit(1);
  }
}

if (isEntrypoint(import.meta.url)) {
  runFrontlineHistory().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
