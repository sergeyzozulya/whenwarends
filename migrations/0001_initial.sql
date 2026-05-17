-- D1 initial schema for whenwarends
-- Immutable time-series snapshots, market state, briefs, and changelog

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  value REAL,
  raw_blob TEXT,
  confidence REAL,
  UNIQUE(metric, source, ts)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_metric_ts ON snapshots(metric, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_source_ts ON snapshots(source, ts);

-- Current state per market; updated frequently
CREATE TABLE IF NOT EXISTS markets (
  market_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  question TEXT NOT NULL,
  resolution_date TEXT NOT NULL,
  category TEXT NOT NULL,
  current_price REAL,
  liquidity_usd REAL,
  last_updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markets_source ON markets(source);
CREATE INDEX IF NOT EXISTS idx_markets_resolution_date ON markets(resolution_date);

-- AI brief drafts and published versions
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lang TEXT NOT NULL,
  date TEXT NOT NULL,
  draft TEXT NOT NULL,
  published TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_review','published','rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  citations TEXT NOT NULL,
  UNIQUE(lang, date)
);
CREATE INDEX IF NOT EXISTS idx_briefs_lang_date ON briefs(lang, date);
CREATE INDEX IF NOT EXISTS idx_briefs_status ON briefs(status);

-- Editorial events with attribution and shift impact
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description_uk TEXT NOT NULL,
  description_en TEXT NOT NULL,
  description_ru TEXT NOT NULL,
  shift_months REAL,
  source_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

-- Methodology change log
CREATE TABLE IF NOT EXISTS changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog_date ON changelog(date);
