// Homepage payload assembly. Reads the repo data files at build time (Node)
// and bakes the numbers into the static HTML — no runtime DB, no client fetch.
// Collectors write the data files weekly via the collect script.

import type { Lang, EventRow, BriefRow, MarketRow, SnapshotRow } from './types';
import {
  readSnapshots,
  readMarkets,
  readEvents,
  readBriefs,
} from './filestore';
import { computeCDF, type CDFPoint } from './cdf';
import { getTranslation } from '../i18n/index';

export interface CurveSet {
  curve: { date: string; probability: number }[];
  knots: { date: string; probability: number; liquidity?: number }[];
  median: string | null;
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
  estimateNote?: boolean;
  /** Explanatory caption rendered below the confidence bar. */
  note?: string;
}

export interface HomePayload {
  lastUpdated: string | null;
  hero: {
    datasets: { ceasefire: CurveSet; peaceDeal?: CurveSet; either?: CurveSet };
    today: string;
    median: string | null;
  };
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
    },
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
  };
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
  staleHours: number,
  estimateNote = false
): IndicatorData {
  if (!row || row.value === null) return { value: null, estimateNote };
  const age = hoursSince(row.ts);
  return {
    value: format(row.value),
    confidence: row.confidence ?? undefined,
    estimateNote,
    degraded: age > staleHours ? { sinceHours: age } : undefined,
  };
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
  const brief = latestPublishedBrief(readBriefs(), lang);

  if (snapshots.length === 0 && markets.length === 0 && !brief) {
    return { ...emptyHomePayload(), events };
  }

  const ceasefire = computeCDF(marketsToCdfPoints(markets));

  const sinceTs = new Date(Date.now() - 365 * 24 * HOURS).toISOString();
  const beliefs: BeliefSeries[] = [];
  for (const source of ['polymarket', 'kalshi'] as const) {
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

  const lastUpdated =
    markets
      .map((m) => m.last_updated)
      .sort()
      .at(-1) ?? null;

  const briefStale = brief
    ? hoursSince(brief.date + 'T00:00:00Z') > 8 * 24
    : false;

  // Combat-zone fire activity: NASA FIRMS emits one detection count per UTC
  // day. The headline is the SUM over the last 5 days (matching the look-back
  // and the sub label) — not one arbitrary partial NRT day. Honest source
  // attribution lives in `sub`; this is measured FIRMS data, not an estimate,
  // so there is no ISW label.
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

  return {
    lastUpdated,
    hero: {
      datasets: { ceasefire },
      today: new Date().toISOString(),
      median: ceasefire.median,
    },
    beliefs,
    events,
    ground: {
      frontline,
      intensity,
      aid: indicatorFrom(
        latestSnapshot(snapshots, 'aid_commitments_eur', 'kiel'),
        (v) => eur.format(v),
        30 * 24
      ),
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
  };
}
