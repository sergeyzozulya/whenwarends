// One-time FIRMS API backfill for the gap the downloaded archive doesn't
// cover. The operator's MODIS archive CSVs end 2024-12-19; this pulls
// 2024-12-20 → now from the FIRMS area API using MODIS_SP (standard
// processing) — SAME instrument as the archive, so the series stays
// consistent (no MODIS↔VIIRS seam except the recent NRT edge from the
// weekly collector).
//
// Chunked (≤5-day windows, the area-API max), resilient (a failed chunk is
// skipped, not fatal), idempotent (appendSnapshots dedupes on
// (metric,source,ts)). Run once, manually: `npm run collect:firms-history`
// (needs FIRMS_MAP_KEY in .dev.vars). Not wired into the weekly collect.

import './loadEnv'; // first: populates process.env from .dev.vars
import type { SnapshotInput } from '../src/lib/types';
import { appendSnapshots } from '../src/lib/filestore';
import { fetchWithRetry } from '../src/lib/sources/contract';
import { UKRAINE_BBOX } from '../src/lib/sources/firms';

const PRODUCT = 'MODIS_SP';
const CHUNK_DAYS = 5; // FIRMS area API max day-range ("Expects [1..5]")
const GAP_START = Date.UTC(2024, 11, 20); // day after archive end (2024-12-19)
const DAY_MS = 24 * 3600 * 1000;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function url(key: string, startMs: number, days: number): string {
  return (
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    `${encodeURIComponent(key)}/${PRODUCT}/${UKRAINE_BBOX}/${days}/${ymd(startMs)}`
  );
}

/** Count detections per acq_date from one area CSV into `into`. */
function countCsv(text: string, into: Map<string, number>): number {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return 0;
  const dateCol = lines[0].split(',').map((h) => h.trim()).indexOf('acq_date');
  if (dateCol < 0) return 0; // not a data CSV (error/empty body)
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const d = (lines[i].split(',')[dateCol] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    into.set(d, (into.get(d) ?? 0) + 1);
    rows++;
  }
  return rows;
}

async function main(): Promise<void> {
  const key = process.env.FIRMS_MAP_KEY?.trim();
  if (!key) {
    console.error('FIRMS_MAP_KEY is not set (.dev.vars) — cannot backfill');
    process.exit(1);
  }

  const endMs = Date.now();
  const perDay = new Map<string, number>();
  let attempted = 0;
  let failed = 0;
  let total = 0;

  for (let s = GAP_START; s <= endMs; s += CHUNK_DAYS * DAY_MS) {
    const days = Math.min(
      CHUNK_DAYS,
      Math.ceil((endMs - s) / DAY_MS) + 1
    );
    attempted++;
    try {
      const res = await fetchWithRetry(url(key, s, days), {
        init: { headers: { accept: 'text/csv' } },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const n = countCsv(await res.text(), perDay);
      total += n;
      console.log(`✓ ${ymd(s)} +${days}d: ${n} detections`);
    } catch (err) {
      failed++;
      console.error(
        `✗ ${ymd(s)} +${days}d: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await sleep(800); // polite pacing
  }

  if (perDay.size === 0 && failed === attempted && attempted > 0) {
    console.error(`every chunk failed (${attempted}) — nothing collected`);
    process.exit(1);
  }

  const days = [...perDay.keys()].sort();
  const snapshots: SnapshotInput[] = days.map((d) => ({
    metric: 'fire_anomalies',
    source: 'firms',
    ts: `${d}T00:00:00.000Z`,
    value: perDay.get(d) as number,
    raw_blob: JSON.stringify({ instrument: 'MODIS', detections: perDay.get(d) }),
    confidence: 0.9,
  }));
  const added = appendSnapshots(snapshots);
  console.log(
    `\nfirms-history: ${total} detections over ${days.length} days ` +
      `(${days[0] ?? '—'} → ${days[days.length - 1] ?? '—'}); ` +
      `${added} new appended` +
      `${added < snapshots.length ? ` (${snapshots.length - added} already present)` : ''}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
