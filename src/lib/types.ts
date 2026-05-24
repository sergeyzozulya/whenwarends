// Shared domain and platform types.
// This module is the contract every collector, worker, and page builds on.
// Keep it dependency-free so it can be imported from any context.

export type Lang = 'uk' | 'en' | 'ru';

export const LANGS = ['uk', 'en', 'ru'] as const;

/**
 * Runtime/collection environment. The Worker only uses ASSETS; the collect
 * script supplies the secrets (from process.env) that collectors read. There
 * is no DB/KV — data lives in versioned repo files (see filestore.ts).
 */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ANTHROPIC_API_KEY: string;
  /** NASA FIRMS area-API MAP_KEY (free). GitHub Actions secret. */
  FIRMS_MAP_KEY: string;
  /** U.S. EIA Open Data API key (free). GitHub Actions secret. */
  EIA_API_KEY: string;
  CONTACT_TO_EMAIL: string;
  CONTACT_FROM_EMAIL: string;
  CONTACT_FROM_NAME: string;
}

// --- Data record shapes (mirror data/*.json + snapshots.ndjson) ---

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
  /** USD liquidity (Polymarket, real money). Null for play-money sources. */
  liquidity_usd: number | null;
  /** Mana liquidity (Manifold, play money). Null for USD sources. */
  liquidity_mana: number | null;
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
  /**
   * True when this brief was reconstructed after the fact from archived
   * snapshot data (scripts/backfill-briefs.ts) rather than written at the
   * time. The UI labels these "reconstructed from archived data" so they are
   * never presented as contemporaneous editorial. Absent = written live.
   */
  reconstructed?: boolean;
}

export interface Citation {
  source: string;
  url: string;
  title?: string;
}

/** A raw candidate article from GDELT, before selection/translation. */
export interface NewsArticle {
  /** Original-language title as returned by GDELT. */
  title: string;
  url: string;
  /** Originating domain, e.g. "reuters.com" (may be empty). */
  domain: string;
  /** ISO-8601 UTC timestamp GDELT first saw the article, or '' if unknown. */
  seenAt: string;
  /** GDELT source-country label, when present. */
  sourceCountry?: string;
  /** GDELT language label of the article, when present (e.g. "English"). */
  language?: string;
  /** Publisher share/OG image URL (GDELT socialimage), hotlinked, if any. */
  image?: string;
  /** True if the source is a flagged Tier-2 amplifier (shown with a warning). */
  flagged?: boolean;
}

/** A title rendered in each of the three site locales. */
export type LocalizedTitle = Record<Lang, string>;

/**
 * A selected, display-ready news item: a curated GDELT article whose title has
 * been translated into all three site locales by the news-selection LLM pass.
 */
export interface NewsItem {
  url: string;
  domain: string;
  seenAt: string;
  sourceCountry?: string;
  image?: string;
  /** True if the source is a flagged Tier-2 amplifier (shown with a warning). */
  flagged?: boolean;
  /** Original-language title (provenance + fallback). */
  original: string;
  /** Title translated into each site locale. */
  title: LocalizedTitle;
}

/** Current related-news snapshot (data/news.json). Overwritten each refresh. */
export interface NewsFile {
  /** YYYY-MM-DD (UTC) the list was collected. */
  asOf: string;
  /** Provenance, e.g. "gdelt". */
  source: string;
  articles: NewsItem[];
}

/** Run metadata (data/meta.json). Overwritten each collect run. */
export interface CollectMeta {
  /** Wall-clock UTC time (ISO-8601) the last collect run executed. */
  lastCollected: string;
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
  /** Stable category key, localized in the page: release | new-source | redesign | privacy. */
  category: string;
  description_uk: string;
  description_en: string;
  description_ru: string;
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
