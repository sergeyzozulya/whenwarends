// Node-only repo-file data store. Replaces D1/KV: the weekly collect script
// appends snapshots and overwrites current market state under data/; the
// static Astro build reads these files at build time. Git is the immutable
// history, audit trail, and backup.
//
// Not imported by the Cloudflare Worker — uses node:fs and only runs in the
// collect script and the Astro build (both Node).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  SnapshotInput,
  SnapshotRow,
  MarketRow,
  EventRow,
  ChangelogRow,
  BriefRow,
  NewsFile,
  CollectMeta,
} from './types';

const DATA_DIR = resolve(process.cwd(), 'data');
const P = {
  snapshots: resolve(DATA_DIR, 'snapshots.ndjson'),
  markets: resolve(DATA_DIR, 'markets.json'),
  events: resolve(DATA_DIR, 'events.json'),
  changelog: resolve(DATA_DIR, 'changelog.json'),
  briefs: resolve(DATA_DIR, 'briefs.json'),
  news: resolve(DATA_DIR, 'news.json'),
  meta: resolve(DATA_DIR, 'meta.json'),
};

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return fallback;
  return JSON.parse(raw) as T;
}

function writeJson(path: string, value: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const snapKey = (s: { metric: string; source: string; ts: string }) =>
  `${s.metric} ${s.source} ${s.ts}`;

/** Full immutable snapshot log, oldest-first. Synthesizes a stable id. */
export function readSnapshots(): SnapshotRow[] {
  if (!existsSync(P.snapshots)) return [];
  const lines = readFileSync(P.snapshots, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.map((line, i) => {
    const r = JSON.parse(line) as SnapshotInput;
    return {
      id: i + 1,
      metric: r.metric,
      source: r.source,
      ts: r.ts,
      value: r.value,
      raw_blob: r.raw_blob ?? null,
      confidence: r.confidence ?? null,
    };
  });
}

/**
 * Append snapshots, skipping any whose (metric, source, ts) already exists —
 * snapshots are immutable and never overwritten. Returns rows actually added.
 */
export function appendSnapshots(rows: SnapshotInput[]): number {
  ensureDir();
  const seen = new Set(readSnapshots().map(snapKey));
  const fresh = rows.filter((r) => {
    const k = snapKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length === 0) return 0;
  const payload =
    fresh
      .map((r) =>
        JSON.stringify({
          metric: r.metric,
          source: r.source,
          ts: r.ts,
          value: r.value,
          raw_blob: r.raw_blob ?? null,
          confidence: r.confidence ?? null,
        })
      )
      .join('\n') + '\n';
  // appendFileSync semantics via read+write keeps a trailing newline tidy.
  const prev = existsSync(P.snapshots) ? readFileSync(P.snapshots, 'utf8') : '';
  writeFileSync(P.snapshots, prev + payload, 'utf8');
  return fresh.length;
}

export function readMarkets(): MarketRow[] {
  return readJson<MarketRow[]>(P.markets, []);
}

/** Upsert current market state by market_id (last write wins). */
export function upsertMarkets(markets: MarketRow[]): void {
  const byId = new Map<string, MarketRow>();
  for (const m of readMarkets()) byId.set(m.market_id, m);
  for (const m of markets) byId.set(m.market_id, m);
  writeJson(
    P.markets,
    [...byId.values()].sort((a, b) =>
      a.resolution_date.localeCompare(b.resolution_date)
    )
  );
}

export function readEvents(): EventRow[] {
  return readJson<EventRow[]>(P.events, []);
}

export function readChangelog(): ChangelogRow[] {
  return readJson<ChangelogRow[]>(P.changelog, []);
}

export function readBriefs(): BriefRow[] {
  return readJson<BriefRow[]>(P.briefs, []);
}

/** Current related-news snapshot, or null if not yet collected. */
export function readNews(): NewsFile | null {
  return readJson<NewsFile | null>(P.news, null);
}

/** Overwrite the related-news file (current state, like markets.json). */
export function writeNews(file: NewsFile): void {
  writeJson(P.news, file);
}

/** Run metadata (when collect last ran), or null before the first run. */
export function readMeta(): CollectMeta | null {
  return readJson<CollectMeta | null>(P.meta, null);
}

/** Overwrite the run-metadata file (current state, like markets.json). */
export function writeMeta(meta: CollectMeta): void {
  writeJson(P.meta, meta);
}

/** Overwrite the briefs file. The draft script upserts; PR review publishes. */
export function writeBriefs(rows: BriefRow[]): void {
  writeJson(
    P.briefs,
    [...rows].sort((a, b) =>
      a.date === b.date ? a.lang.localeCompare(b.lang) : a.date.localeCompare(b.date)
    )
  );
}
