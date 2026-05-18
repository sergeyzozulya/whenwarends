// Shared domain and platform types.
// This module is the contract every collector, worker, and page builds on.
// Keep it dependency-free so it can be imported from any context.

export type Lang = 'uk' | 'en' | 'ru';

export const LANGS = ['uk', 'en', 'ru'] as const;

/** Cloudflare Worker bindings. Mirrors wrangler.toml. */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  KV_CACHE: KVNamespace;
  ANTHROPIC_API_KEY: string;
  /** NASA FIRMS area-API MAP_KEY (free). Secret, not a wrangler [vars] entry. */
  FIRMS_MAP_KEY: string;
  CONTACT_TO_EMAIL: string;
  CONTACT_FROM_EMAIL: string;
  CONTACT_FROM_NAME: string;
}

// --- D1 row shapes (mirror migrations/0001_initial.sql) ---

export interface SnapshotRow {
  id: number;
  metric: string;
  source: string;
  ts: string; // ISO-8601 UTC
  value: number | null;
  raw_blob: string | null;
  confidence: number | null;
}

/** A snapshot to insert. id is assigned by D1. */
export interface SnapshotInput {
  metric: string;
  source: string;
  ts: string; // ISO-8601 UTC
  value: number | null;
  raw_blob?: string | null;
  confidence?: number | null;
}

export interface MarketRow {
  market_id: string;
  source: string;
  question: string;
  resolution_date: string; // ISO-8601 UTC
  category: string;
  current_price: number | null; // 0–1 probability
  liquidity_usd: number | null;
  last_updated: string; // ISO-8601 UTC
}

export type BriefStatus = 'pending_review' | 'published' | 'rejected';

export interface BriefRow {
  id: number;
  lang: Lang;
  date: string; // YYYY-MM-DD (UTC editorial date)
  draft: string;
  published: string | null;
  status: BriefStatus;
  created_at: string; // ISO-8601 UTC
  reviewed_at: string | null;
  citations: string; // JSON-encoded Citation[]
}

export interface Citation {
  source: string;
  url: string;
  title?: string;
}

export interface EventRow {
  id: number;
  date: string; // YYYY-MM-DD
  description_uk: string;
  description_en: string;
  description_ru: string;
  shift_months: number | null;
  source_url: string | null;
}

export interface ChangelogRow {
  id: number;
  date: string; // YYYY-MM-DD
  description: string;
  category: string;
}

// --- Collector contract ---

/**
 * Every data source implements this. A run pulls fresh data, parses it at the
 * boundary with Zod, and returns snapshots (and optionally markets) to persist.
 * Collectors must be pure with respect to the DB: the runner persists, not the
 * collector. This keeps each source independently testable with mock fetch.
 */
export interface CollectorResult {
  snapshots: SnapshotInput[];
  markets?: MarketRow[];
}

export interface Collector {
  /** Stable identifier, also used as the `source` column value. */
  readonly name: string;
  /** Pull + parse. Throws on unrecoverable error; runner handles retry/backoff. */
  run(env: Env): Promise<CollectorResult>;
}
