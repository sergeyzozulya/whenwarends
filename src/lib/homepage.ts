// Homepage payload assembly. Reads the repo data files at build time (Node)
// and bakes the numbers into the static HTML — no runtime DB, no client fetch.
// Collectors write the data files weekly via the collect script.

import type {
  Lang,
  EventRow,
  BriefRow,
  MarketRow,
  SnapshotRow,
  Citation,
} from './types';
import {
  readSnapshots,
  readMarkets,
  readEvents,
  readBriefs,
} from './filestore';
import { computeCDF, type CDFPoint } from './cdf';
import { marketBucket, isoToMs, type HeroMarket } from './heroChartData';
import { asOfMetrics, type AsOfMetrics } from './briefContext';
import { getTranslation } from '../i18n/index';

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

export interface BeliefSeries {
  label: string;
  points: number[];
  current: string | null;
}

export interface IndicatorData {
  value: string | null;
  sub?: string;
  confidence?: number;
  degraded?: { sinceHours: number };
  /** Explanatory caption rendered below the confidence bar. */
  note?: string;
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
  beliefs: BeliefSeries[];
  events: EventRow[];
  ground: {
    frontline: IndicatorData;
    intensity: IndicatorData;
    aid: IndicatorData;
    economy: IndicatorData;
    ukEconomy: IndicatorData;
  };
  brief: BriefRow | null;
  briefStale: boolean;
  /** Every published brief for this lang, newest-first, with the metric
   *  picture as it stood on that brief's date. Drives the inline timeline. */
  briefArchive: BriefArchiveEntry[];
}

export interface BriefArchiveEntry {
  date: string; // YYYY-MM-DD (UTC editorial date)
  text: string; // the published text
  citations: Citation[];
  /** True = reconstructed after the fact from archived data (labelled). */
  reconstructed: boolean;
  /** Numbers as of `date`, for the "what the data showed then" column. */
  metrics: AsOfMetrics;
}

const EMPTY_INDICATOR: IndicatorData = { value: null };

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
    beliefs: [],
    events: [],
    ground: {
      frontline: EMPTY_INDICATOR,
      intensity: EMPTY_INDICATOR,
      aid: EMPTY_INDICATOR,
      economy: EMPTY_INDICATOR,
      ukEconomy: EMPTY_INDICATOR,
    },
    brief: null,
    briefStale: false,
    briefArchive: [],
  };
}

/** Defensive Citation[] parse (mirrors DailyBrief): drop anything malformed. */
function parseCitations(raw: string | undefined): Citation[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Citation =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { source?: unknown }).source === 'string' &&
        typeof (c as { url?: unknown }).url === 'string'
    );
  } catch {
    return [];
  }
}

/** Published briefs for `lang`, newest-first, each with as-of metrics. */
function buildBriefArchive(
  briefs: BriefRow[],
  lang: Lang,
  snapshots: SnapshotRow[]
): BriefArchiveEntry[] {
  return briefs
    .filter(
      (b) => b.lang === lang && b.status === 'published' && b.published !== null
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((b) => ({
      date: b.date,
      text: b.published as string,
      citations: parseCitations(b.citations),
      reconstructed: b.reconstructed === true,
      // Inclusive end-of-day: the metric picture as it stood on that date.
      metrics: asOfMetrics(snapshots, `${b.date}T23:59:59.999Z`),
    }));
}

const HOURS = 3600_000;
const fmtPct = (p: number) => `${Math.round(p * 100)}%`;

function hoursSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / HOURS));
}

function latestSnapshot(
  rows: SnapshotRow[],
  metric: string,
  source: string
): SnapshotRow | null {
  let best: SnapshotRow | null = null;
  for (const r of rows) {
    if (r.metric !== metric || r.source !== source) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best;
}

function snapshotSeries(
  rows: SnapshotRow[],
  metric: string,
  source: string,
  sinceTs: string
): SnapshotRow[] {
  return rows
    .filter(
      (r) => r.metric === metric && r.source === source && r.ts >= sinceTs
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function indicatorFrom(
  row: SnapshotRow | null,
  format: (v: number) => string,
  staleHours: number
): IndicatorData {
  if (!row || row.value === null) return { value: null };
  const age = hoursSince(row.ts);
  return {
    value: format(row.value),
    confidence: row.confidence ?? undefined,
    degraded: age > staleHours ? { sinceHours: age } : undefined,
  };
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

function marketsToCdfPoints(markets: MarketRow[]): CDFPoint[] {
  return markets
    .filter((m) => m.current_price !== null)
    .map((m) => ({
      date: m.resolution_date,
      probability: m.current_price as number, // filtered non-null above
      liquidity: m.liquidity_usd ?? undefined,
    }));
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

  if (snapshots.length === 0 && markets.length === 0 && !brief) {
    return { ...emptyHomePayload(), events };
  }

  const briefArchive = buildBriefArchive(allBriefs, lang, snapshots);
  const history = buildHistory(snapshots);
  const ceasefire = computeCDF(marketsToCdfPoints(markets));

  // The individual markets, plotted distinctly on the hero (the CDF curve is
  // the aggregate; these are the raw bets it's fitted through).
  const heroMarkets: HeroMarket[] = markets
    .filter((m) => m.current_price !== null)
    .map((m) => ({
      x: isoToMs(m.resolution_date),
      y: m.current_price as number,
      bucket: marketBucket(m.question),
      source: m.source,
      question: m.question,
      liquidity: m.liquidity_usd ?? null,
    }));

  const sinceTs = new Date(Date.now() - 365 * 24 * HOURS).toISOString();
  const beliefs: BeliefSeries[] = [];
  for (const source of ['polymarket', 'manifold'] as const) {
    const series = snapshotSeries(
      snapshots,
      'war_end_probability',
      source,
      sinceTs
    );
    if (series.length === 0) continue;
    const points = series
      .map((s) => s.value)
      .filter((v): v is number => v !== null);
    const last = points.at(-1);
    beliefs.push({
      label: source,
      points,
      current: last !== undefined ? fmtPct(last) : null,
    });
  }

  const eur = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });

  // Freshest data point we hold (markets.json is no longer used).
  const lastUpdated =
    snapshots.map((s) => s.ts).sort().at(-1) ?? null;

  const briefStale = brief
    ? hoursSince(brief.date + 'T00:00:00Z') > 8 * 24
    : false;

  // Combat-zone fire activity: NASA FIRMS emits one detection count per UTC
  // day. The headline is the SUM over the last 5 days (matching the look-back
  // and the sub label) — not one arbitrary partial NRT day. Honest source
  // attribution lives in `sub`; this is measured FIRMS data, not an estimate.
  const fireWindow = snapshotSeries(
    snapshots,
    'fire_anomalies',
    'firms',
    new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()
  );
  let frontline: IndicatorData = { value: null };
  if (fireWindow.length > 0) {
    const total = fireWindow.reduce((s, r) => s + (r.value ?? 0), 0);
    const latestTs = fireWindow[fireWindow.length - 1].ts;
    const age = hoursSince(latestTs);
    frontline = {
      value: String(Math.round(total)),
      sub: getTranslation(lang, 'ground.fireActivity'),
      degraded: age > 72 ? { sinceHours: age } : undefined,
    };
  }

  // Conflict intensity: GDELT "volume intensity" — the share of monitored
  // global news coverage matching the war query (latest day). It's a
  // normalized index, not a count, so label the unit and explain it.
  const intensity = indicatorFrom(
    latestSnapshot(snapshots, 'conflict_intensity', 'gdelt'),
    (v) => v.toFixed(1),
    48
  );
  if (intensity.value !== null) {
    intensity.sub = getTranslation(lang, 'ground.intensityUnit');
    intensity.note = getTranslation(lang, 'ground.intensityNote');
  }

  // Aid headline = Kiel's real cumulative ALLOCATED total (latest point of
  // the monotonic Fig A22 series — aid actually delivered/specified). We use
  // allocated, not committed: there is no honest cumulative-committed series
  // (summing the monthly flow ≈ 2× the real figure). No fallback to monthly
  // committed — committed is fully retired from the UI.
  const aidRow = latestSnapshot(
    snapshots,
    'aid_allocated_cumulative_eur',
    'kiel'
  );
  let aid: IndicatorData = { value: null };
  if (aidRow && aidRow.value !== null) {
    aid = {
      value: eur.format(aidRow.value),
      sub: getTranslation(lang, 'ground.aidTotal'),
      confidence: aidRow.confidence ?? undefined,
    };
  }

  return {
    lastUpdated,
    hero: {
      datasets: { ceasefire },
      today: new Date().toISOString(),
      median: ceasefire.median,
      markets: heroMarkets,
    },
    history,
    beliefs,
    events,
    ground: {
      frontline,
      intensity,
      aid,
      economy: indicatorFrom(
        latestSnapshot(snapshots, 'rub_usd_rate', 'cbr'),
        (v) => `${v.toFixed(2)} RUB / USD`,
        72
      ),
      ukEconomy: indicatorFrom(
        latestSnapshot(snapshots, 'uah_usd_rate', 'nbu'),
        (v) => `${v.toFixed(2)} UAH / USD`,
        72
      ),
    },
    brief,
    briefStale,
    briefArchive,
  };
}
