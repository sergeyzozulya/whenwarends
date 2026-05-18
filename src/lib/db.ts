// Typed D1 query helpers. All SQL lives here; downstream code passes values
// only through bound parameters (never string-interpolated) to avoid injection.
// Snapshots are immutable: insert is idempotent on UNIQUE(metric, source, ts).

import type {
  Env,
  SnapshotInput,
  SnapshotRow,
  MarketRow,
  BriefRow,
  BriefStatus,
  EventRow,
  ChangelogRow,
  Lang,
} from './types';

// --- snapshots (immutable time-series) ---

/**
 * Insert a snapshot. Idempotent: a re-run with the same (metric, source, ts)
 * is silently ignored rather than overwriting. Returns true if a row was added.
 */
export async function insertSnapshot(env: Env, s: SnapshotInput): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO snapshots (metric, source, ts, value, raw_blob, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(s.metric, s.source, s.ts, s.value, s.raw_blob ?? null, s.confidence ?? null)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Batch insert snapshots in one D1 transaction. Returns rows actually added. */
export async function insertSnapshots(env: Env, rows: SnapshotInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO snapshots (metric, source, ts, value, raw_blob, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const batch = rows.map((s) =>
    stmt.bind(s.metric, s.source, s.ts, s.value, s.raw_blob ?? null, s.confidence ?? null)
  );
  const results = await env.DB.batch(batch);
  return results.reduce((n: number, r) => n + (r.meta.changes ?? 0), 0);
}

export async function getLatestSnapshot(
  env: Env,
  metric: string,
  source: string
): Promise<SnapshotRow | null> {
  return env.DB.prepare(
    `SELECT * FROM snapshots WHERE metric = ? AND source = ? ORDER BY ts DESC LIMIT 1`
  )
    .bind(metric, source)
    .first<SnapshotRow>();
}

/** Time-ordered series for a metric, optionally filtered by source and window. */
export async function getSnapshotSeries(
  env: Env,
  metric: string,
  opts: { source?: string; sinceTs?: string; limit?: number } = {}
): Promise<SnapshotRow[]> {
  const where: string[] = ['metric = ?'];
  const binds: unknown[] = [metric];
  if (opts.source) {
    where.push('source = ?');
    binds.push(opts.source);
  }
  if (opts.sinceTs) {
    where.push('ts >= ?');
    binds.push(opts.sinceTs);
  }
  let sql = `SELECT * FROM snapshots WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
  if (opts.limit) {
    sql += ' LIMIT ?';
    binds.push(opts.limit);
  }
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<SnapshotRow>();
  return res.results ?? [];
}

// --- markets (mutable current state) ---

/** Upsert current market state, keyed by market_id. */
export async function upsertMarket(env: Env, m: MarketRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO markets
       (market_id, source, question, resolution_date, category, current_price, liquidity_usd, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(market_id) DO UPDATE SET
       source = excluded.source,
       question = excluded.question,
       resolution_date = excluded.resolution_date,
       category = excluded.category,
       current_price = excluded.current_price,
       liquidity_usd = excluded.liquidity_usd,
       last_updated = excluded.last_updated`
  )
    .bind(
      m.market_id,
      m.source,
      m.question,
      m.resolution_date,
      m.category,
      m.current_price,
      m.liquidity_usd,
      m.last_updated
    )
    .run();
}

export async function upsertMarkets(env: Env, markets: MarketRow[]): Promise<void> {
  for (const m of markets) await upsertMarket(env, m);
}

export async function getMarkets(
  env: Env,
  opts: { source?: string; category?: string } = {}
): Promise<MarketRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.source) {
    where.push('source = ?');
    binds.push(opts.source);
  }
  if (opts.category) {
    where.push('category = ?');
    binds.push(opts.category);
  }
  const sql =
    `SELECT * FROM markets` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY resolution_date ASC`;
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<MarketRow>();
  return res.results ?? [];
}

// --- briefs (AI drafts; never auto-publish) ---

/** Create or replace today's draft for a language. Status stays pending_review. */
export async function upsertBriefDraft(
  env: Env,
  args: { lang: Lang; date: string; draft: string; citations: string; createdAt: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO briefs (lang, date, draft, status, created_at, citations)
     VALUES (?, ?, ?, 'pending_review', ?, ?)
     ON CONFLICT(lang, date) DO UPDATE SET
       draft = excluded.draft,
       citations = excluded.citations,
       status = 'pending_review',
       created_at = excluded.created_at,
       published = NULL,
       reviewed_at = NULL`
  )
    .bind(args.lang, args.date, args.draft, args.createdAt, args.citations)
    .run();
}

/** Editor action. Publishing requires explicit published text (human-reviewed). */
export async function setBriefStatus(
  env: Env,
  args: { lang: Lang; date: string; status: BriefStatus; published?: string; reviewedAt: string }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE briefs SET status = ?, published = ?, reviewed_at = ?
     WHERE lang = ? AND date = ?`
  )
    .bind(args.status, args.published ?? null, args.reviewedAt, args.lang, args.date)
    .run();
}

/** Latest published brief for a language, or null. Drives the public page. */
export async function getLatestPublishedBrief(
  env: Env,
  lang: Lang
): Promise<BriefRow | null> {
  return env.DB.prepare(
    `SELECT * FROM briefs WHERE lang = ? AND status = 'published'
     ORDER BY date DESC LIMIT 1`
  )
    .bind(lang)
    .first<BriefRow>();
}

export async function getPendingBriefs(env: Env, date: string): Promise<BriefRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM briefs WHERE date = ? AND status = 'pending_review' ORDER BY lang`
  )
    .bind(date)
    .all<BriefRow>();
  return res.results ?? [];
}

// --- events ---

export async function getRecentEvents(env: Env, limit = 4): Promise<EventRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM events ORDER BY date DESC LIMIT ?`
  )
    .bind(limit)
    .all<EventRow>();
  return res.results ?? [];
}

// --- changelog ---

export async function addChangelogEntry(
  env: Env,
  entry: { date: string; description: string; category: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO changelog (date, description, category) VALUES (?, ?, ?)`
  )
    .bind(entry.date, entry.description, entry.category)
    .run();
}

export async function getChangelog(env: Env, limit = 100): Promise<ChangelogRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM changelog ORDER BY date DESC LIMIT ?`
  )
    .bind(limit)
    .all<ChangelogRow>();
  return res.results ?? [];
}
