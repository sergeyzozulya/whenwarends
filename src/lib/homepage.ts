// Homepage payload assembly. Reads the repo data files at build time (Node)
// and bakes the numbers into the static HTML — no runtime DB, no client fetch.
// Collectors write the data files weekly via the collect script.

import type { Lang, EventRow, BriefRow, SnapshotRow, NewsItem } from './types';
import {
  readSnapshots,
  readMarkets,
  readEvents,
  readBriefs,
  readNews,
  readMeta,
} from './filestore';
import { computeCDF } from './cdf';
import { marketBucket, isoToMs, type HeroMarket } from './heroChartData';
import {
  deriveSelections,
  deriveConsensus,
  qualifyMarkets,
  marketLiquidity,
  marketsToCdfPoints,
  CARD_SOURCE,
  CONSENSUS_PROB_METRIC,
  MARKET_PRICE_METRIC,
  type CardPicks,
  type ConsensusPoint,
} from './cards';

export interface CurveSet {
  curve: { date: string; probability: number }[];
  knots: { date: string; probability: number; liquidity?: number }[];
  median: string | null;
}

/** A dense metric time-series for the secondary timelines. */
export interface HistorySeries {
  /** Stable metric key (resolved to a localized label in the page). */
  key: string;
  /** Chronological points: t = epoch ms (UTC), v = value. */
  points: { t: number; v: number }[];
}

/** A compact trend for a sparkline + signed delta (the stat-card / hero trend). */
export interface TrendData {
  /** Chronological 0–1 values for the sparkline (windowed + downsampled). */
  points: number[];
  /** Latest value, 0–1, or null when no data. */
  current: number | null;
  /** Signed change in percentage points vs the comparison point, or null. */
  deltaPts: number | null;
  /** Days between the comparison point and the latest (honest delta window). */
  deltaDays: number | null;
  /** Total stored points all-time (distinguishes "collecting" from a real trend). */
  count: number;
}

export interface HomePayload {
  lastUpdated: string | null;
  hero: {
    datasets: { ceasefire: CurveSet; peaceDeal?: CurveSet; either?: CurveSet };
    today: string;
    median: string | null;
    /** Individual prediction markets, plotted distinctly on the hero. */
    markets: HeroMarket[];
  };
  /** Secondary timelines: every metric we actually have, dense, 2022→now. */
  history: HistorySeries[];
  /** The two stat-card selections (closest, optimistic). */
  cards: CardPicks;
  /** Hero consensus: liquidity-weighted centroid (probability + date). */
  consensus: ConsensusPoint | null;
  /** Trend (sparkline + delta) for the consensus and each selected card market. */
  trends: { consensus: TrendData; closest: TrendData; optimistic: TrendData };
  events: EventRow[];
  brief: BriefRow | null;
  briefStale: boolean;
  /** Selected, locale-translated related news (GDELT), shown beside the brief. */
  news: NewsItem[];
  /** YYYY-MM-DD the news list was collected, or null. */
  newsAsOf: string | null;
}

const EMPTY_TREND: TrendData = {
  points: [],
  current: null,
  deltaPts: null,
  deltaDays: null,
  count: 0,
};

/** Stable empty payload (data files absent or empty). */
export function emptyHomePayload(): HomePayload {
  return {
    lastUpdated: null,
    hero: {
      datasets: { ceasefire: { curve: [], knots: [], median: null } },
      today: new Date().toISOString(),
      median: null,
      markets: [],
    },
    history: [],
    cards: { closest: null, optimistic: null },
    consensus: null,
    trends: {
      consensus: EMPTY_TREND,
      closest: EMPTY_TREND,
      optimistic: EMPTY_TREND,
    },
    events: [],
    brief: null,
    briefStale: false,
    news: [],
    newsAsOf: null,
  };
}

const HOURS = 3600_000;

function hoursSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / HOURS));
}

// Dense per-metric history for the main timeline — every series we actually
// retain, full span. One point per (metric,source,ts); war_end_probability is
// the cross-source mean per ts. No fabrication: only stored values, sorted.
const HISTORY_SPECS: { key: string; metric: string; source?: string }[] = [
  { key: 'intensity', metric: 'conflict_intensity', source: 'gdelt' },
  { key: 'tone', metric: 'conflict_tone', source: 'gdelt' },
  { key: 'aid', metric: 'aid_allocated_cumulative_eur', source: 'kiel' },
  { key: 'rub', metric: 'rub_usd_rate', source: 'cbr' },
  { key: 'uah', metric: 'uah_usd_rate', source: 'nbu' },
  { key: 'fire', metric: 'fire_anomalies', source: 'firms' },
  // GDP — real, % y/y, quarterly (World Bank GEM). Inflation — CPI, % y/y,
  // monthly (RU: World Bank GEM; UA: decoded NBU headline series).
  { key: 'ruGdp', metric: 'ru_gdp_yoy', source: 'worldbank' },
  { key: 'uaGdp', metric: 'ua_gdp_yoy', source: 'worldbank' },
  { key: 'ruCpi', metric: 'ru_cpi_yoy', source: 'worldbank' },
  { key: 'uaCpi', metric: 'ua_cpi_yoy', source: 'nbu' },
  { key: 'ruLoss', metric: 'ru_equipment_losses', source: 'oryx' },
  { key: 'uaLoss', metric: 'ua_equipment_losses', source: 'oryx' },
  { key: 'aid', metric: 'aid_allocated_cumulative_eur', source: 'kiel' },
  { key: 'oil', metric: 'oil_brent_usd', source: 'eia' },
  { key: 'front', metric: 'occupied_area_km2', source: 'deepstate' },
  { key: 'revenue', metric: 'ru_fossil_revenue_eur_cumulative', source: 'crea' },
  { key: 'refugees', metric: 'refugees_from_ukraine', source: 'unhcr' },
  { key: 'idps', metric: 'ua_idps', source: 'unhcr' },
  { key: 'prob', metric: 'war_end_probability' }, // mean across sources/ts
];

function buildHistory(rows: SnapshotRow[]): HistorySeries[] {
  const out: HistorySeries[] = [];
  for (const spec of HISTORY_SPECS) {
    // Collect value(s) per ts; average when a ts has several (cross-source
    // probability, or multiple same-day points).
    const byTs = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (r.metric !== spec.metric || r.value === null) continue;
      if (spec.source && r.source !== spec.source) continue;
      const a = byTs.get(r.ts) ?? { sum: 0, n: 0 };
      a.sum += r.value;
      a.n += 1;
      byTs.set(r.ts, a);
    }
    const points = [...byTs.entries()]
      .map(([ts, a]) => ({ t: Date.parse(ts), v: a.sum / a.n }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((x, y) => x.t - y.t);
    if (points.length > 0) out.push({ key: spec.key, points });
  }
  return out;
}

/** Evenly sample a series down to at most `max` points, keeping first + last. */
function downsample<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const out: T[] = [];
  const step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

const DAY = 24 * HOURS;

/**
 * Build a compact trend for one metric: the chronological (mean-per-ts) values
 * windowed for a sparkline, plus a signed percentage-point delta vs the stored
 * point nearest to `windowDays` ago. No fabrication — only stored values.
 */
function buildTrend(
  rows: SnapshotRow[],
  metric: string,
  source: string | undefined,
  sinceMs: number,
  windowDays: number
): TrendData {
  const byTs = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.metric !== metric || r.value === null) continue;
    if (source && r.source !== source) continue;
    const a = byTs.get(r.ts) ?? { sum: 0, n: 0 };
    a.sum += r.value;
    a.n += 1;
    byTs.set(r.ts, a);
  }
  const all = [...byTs.entries()]
    .map(([ts, a]) => ({ t: Date.parse(ts), v: a.sum / a.n }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((x, y) => x.t - y.t);

  const count = all.length;
  if (count === 0) return { ...EMPTY_TREND };

  const last = all[count - 1];
  let windowed = all.filter((p) => p.t >= sinceMs);
  if (windowed.length < 2) windowed = all;
  const points = downsample(windowed, 60).map((p) => p.v);

  let deltaPts: number | null = null;
  let deltaDays: number | null = null;
  const earlier = all.filter((p) => p.t < last.t);
  if (earlier.length > 0) {
    const target = last.t - windowDays * DAY;
    let base = earlier[0];
    let bestD = Math.abs(base.t - target);
    for (const p of earlier) {
      const d = Math.abs(p.t - target);
      if (d < bestD) {
        bestD = d;
        base = p;
      }
    }
    deltaPts = (last.v - base.v) * 100;
    deltaDays = Math.round((last.t - base.t) / DAY);
  }

  return { points, current: last.v, deltaPts, deltaDays, count };
}

function latestPublishedBrief(briefs: BriefRow[], lang: Lang): BriefRow | null {
  let best: BriefRow | null = null;
  for (const b of briefs) {
    if (b.lang !== lang || b.status !== 'published' || b.published === null)
      continue;
    if (!best || b.date > best.date) best = b;
  }
  return best;
}

/** Assemble the payload from the repo data files (build-time, synchronous). */
export function loadHomePayload(lang: Lang): HomePayload {
  const snapshots = readSnapshots();
  const markets = readMarkets();
  const events = [...readEvents()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  const allBriefs = readBriefs();
  const brief = latestPublishedBrief(allBriefs, lang);
  const newsFile = readNews();
  const news = newsFile?.articles ?? [];
  const newsAsOf = newsFile?.asOf ?? null;

  if (snapshots.length === 0 && markets.length === 0 && !brief) {
    return { ...emptyHomePayload(), events, news, newsAsOf };
  }

  const history = buildHistory(snapshots);
  // CDF over the qualified, cross-source-weighted markets (quality filtered
  // upstream, so the curve's own USD floor is disabled — see cards.ts §8.3).
  const ceasefire = computeCDF(marketsToCdfPoints(markets), {
    liquidityFloorUsd: 0,
  });

  const nowMs = Date.now();
  // The two card selections + the consensus centroid (SPEC §8.5).
  const cards = deriveSelections(markets, nowMs);
  const consensus = deriveConsensus(markets);

  // Per-market price history (metric market_price, source = market_id), for the
  // card sparklines and per-point tooltips.
  const historyByMarket = new Map<string, number[]>();
  {
    const acc = new Map<string, { t: number; v: number }[]>();
    for (const r of snapshots) {
      if (r.metric !== MARKET_PRICE_METRIC || r.value === null) continue;
      const arr = acc.get(r.source) ?? [];
      arr.push({ t: Date.parse(r.ts), v: r.value });
      acc.set(r.source, arr);
    }
    for (const [id, arr] of acc) {
      arr.sort((a, b) => a.t - b.t);
      historyByMarket.set(id, arr.map((p) => p.v));
    }
  }

  const trends = {
    // Consensus trend from the tracked centroid probability.
    consensus: buildTrend(snapshots, CONSENSUS_PROB_METRIC, CARD_SOURCE, 0, 30),
    // Each card's trend is the SELECTED market's own price history.
    closest: cards.closest
      ? buildTrend(snapshots, MARKET_PRICE_METRIC, cards.closest.marketId, 0, 30)
      : { ...EMPTY_TREND },
    optimistic: cards.optimistic
      ? buildTrend(snapshots, MARKET_PRICE_METRIC, cards.optimistic.marketId, 0, 30)
      : { ...EMPTY_TREND },
  };

  // Every qualified market (both sources) plotted on the hero, each carrying
  // its own history for the tooltip sparkline.
  const heroMarkets: HeroMarket[] = qualifyMarkets(markets).map((m) => {
    const liq = marketLiquidity(m);
    return {
      id: m.market_id,
      x: isoToMs(m.resolution_date),
      y: m.current_price as number,
      bucket: marketBucket(m.question),
      source: m.source,
      question: m.question,
      liquidity: liq.value,
      liquidityUnit: liq.unit,
      history: downsample(historyByMarket.get(m.market_id) ?? [], 60),
    };
  });

  // "Last updated" = the real time the collect run executed (data/meta.json).
  // Fall back to the freshest snapshot for data collected before meta.json
  // existed — excluding future-dated points, since NBU publishes the official
  // UAH/USD rate ahead for the next business day (valid for the FX series, but
  // it must not push the label into the future).
  const nowIso = new Date().toISOString();
  const lastUpdated =
    readMeta()?.lastCollected ??
    snapshots
      .map((s) => s.ts)
      .filter((ts) => ts <= nowIso)
      .sort()
      .at(-1) ??
    null;

  const briefStale = brief
    ? hoursSince(brief.date + 'T00:00:00Z') > 8 * 24
    : false;

  return {
    lastUpdated,
    hero: {
      datasets: { ceasefire },
      today: new Date().toISOString(),
      median: ceasefire.median,
      markets: heroMarkets,
    },
    history,
    cards,
    consensus,
    trends,
    events,
    brief,
    briefStale,
    news,
    newsAsOf,
  };
}
