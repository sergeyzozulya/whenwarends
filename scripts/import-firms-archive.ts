// One-time FIRMS archive import. Ingests the operator-downloaded FIRMS
// Archive CSVs in data/archive/ (e.g. modis_<year>_Ukraine.csv) into the
// snapshot store as the historical `fire_anomalies` series — the recurring
// firms collector stays current-only (VIIRS NRT). No network, no API key:
// the operator fetched the archive from
// https://firms.modaps.eosdis.nasa.gov/download/ ; this just parses + counts.
//
// One snapshot per UTC calendar day = number of fire detections that day
// (same metric/source as the live collector so it flows into asOfMetrics and
// the timeline). Idempotent: appendSnapshots dedupes on (metric,source,ts).
//
// HONEST CAVEAT (logged): the archive files are MODIS; the live collector is
// VIIRS S-NPP. Detection counts are not directly comparable across
// instruments, so the 2022–2024 archive segment and the recent VIIRS segment
// have a magnitude discontinuity. We record the instrument in raw_blob and
// surface this so the proxy is read as "fire activity trend", not an absolute.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SnapshotInput } from '../src/lib/types';
import { appendSnapshots } from '../src/lib/filestore';

const ARCHIVE_DIR = resolve(process.cwd(), 'data/archive');

function listArchiveCsvs(): string[] {
  let names: string[];
  try {
    names = readdirSync(ARCHIVE_DIR);
  } catch {
    throw new Error(`no ${ARCHIVE_DIR} directory — nothing to import`);
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.csv'))
    .sort()
    .map((n) => resolve(ARCHIVE_DIR, n));
}

/** Count detections per acq_date across one CSV. Header-driven, not fixed. */
function countByDay(path: string, into: Map<string, number>): number {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return 0;
  const header = lines[0].split(',').map((h) => h.trim());
  const dateCol = header.indexOf('acq_date');
  if (dateCol < 0) {
    throw new Error(`${path}: no acq_date column in header`);
  }
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const d = (cells[dateCol] ?? '').trim();
    // FIRMS acq_date is a UTC calendar date YYYY-MM-DD.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // skip a malformed row
    into.set(d, (into.get(d) ?? 0) + 1);
    rows++;
  }
  return rows;
}

function main(): void {
  const files = listArchiveCsvs();
  if (files.length === 0) {
    console.error(`no CSVs in ${ARCHIVE_DIR} — nothing to import`);
    process.exit(1);
  }

  const perDay = new Map<string, number>();
  let totalRows = 0;
  for (const f of files) {
    const n = countByDay(f, perDay);
    totalRows += n;
    console.log(`✓ ${f.split('/').pop()}: ${n} detections`);
  }

  const days = [...perDay.keys()].sort();
  const snapshots: SnapshotInput[] = days.map((d) => ({
    metric: 'fire_anomalies',
    source: 'firms',
    ts: `${d}T00:00:00.000Z`,
    value: perDay.get(d) as number,
    raw_blob: JSON.stringify({ instrument: 'MODIS', detections: perDay.get(d) }),
    // Standard-processed archive: high confidence as a daily count, but the
    // MODIS↔VIIRS instrument change means cross-segment magnitude differs.
    confidence: 0.9,
  }));

  const added = appendSnapshots(snapshots);
  console.log(
    `\nimport-firms-archive: ${totalRows} detections over ${days.length} days ` +
      `(${days[0]} → ${days[days.length - 1]}); ${added} new snapshots appended` +
      `${added < snapshots.length ? ` (${snapshots.length - added} already present)` : ''}.`
  );
  console.log(
    'NOTE: archive is MODIS; live collector is VIIRS — counts are a trend ' +
      'proxy, not comparable in absolute terms across the 2024/recent seam.'
  );
}

main();
