// Homepage payload assembly. The Worker reads D1 via db.ts, computes the CDF,
// and caches the result in KV (see kv.ts). The static page renders the empty
// payload at build time and graceful empty/degraded states; the runtime
// /api/homepage route serves the live KV-cached payload.

import type { Env, Lang, EventRow, BriefRow, MarketRow } from './types';
import {
  getMarkets,
  getSnapshotSeries,
  getLatestSnapshot,
  getRecentEvents,
  getLatestPublishedBrief,
} from './db';
import { computeCDF, type CDFPoint } from './cdf';
import { CACHE_KEYS, getCached, setCached } from './kv';

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
  };
  brief: BriefRow | null;
  briefStale: boolean;
}

const EMPTY_INDICATOR: IndicatorData = { value: null };

/** Stable empty payload for the static build (no D1 at build time). */
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

/** Snapshot → indicator, flagging staleness past `staleHours`. */
function indicatorFrom(
  row: { value: number | null; ts: string; confidence: number | null } | null,
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

/** Assemble the live payload from D1. */
export async function buildHomePayload(
  env: Env,
  lang: Lang
): Promise<HomePayload> {
  const [markets, events, brief] = await Promise.all([
    getMarkets(env),
    getRecentEvents(env, 4),
    getLatestPublishedBrief(env, lang),
  ]);

  const ceasefire = computeCDF(marketsToCdfPoints(markets));

  const sinceTs = new Date(Date.now() - 365 * 24 * HOURS).toISOString();
  const beliefs: BeliefSeries[] = [];
  for (const source of ['polymarket', 'kalshi'] as const) {
    const series = await getSnapshotSeries(env, 'war_end_probability', {
      source,
      sinceTs,
    });
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

  const [fire, intensity, aid, rub] = await Promise.all([
    getLatestSnapshot(env, 'fire_anomalies', 'firms'),
    getLatestSnapshot(env, 'conflict_intensity', 'gdelt'),
    getLatestSnapshot(env, 'aid_commitments_eur', 'kiel'),
    getLatestSnapshot(env, 'rub_usd_rate', 'cbr'),
  ]);

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
      frontline: indicatorFrom(fire, (v) => `${Math.round(v)}`, 48, true),
      intensity: indicatorFrom(intensity, (v) => v.toFixed(1), 48),
      aid: indicatorFrom(aid, (v) => eur.format(v), 30 * 24),
      economy: indicatorFrom(rub, (v) => `${v.toFixed(2)} RUB / USD`, 72),
    },
    brief,
    briefStale,
  };
}

/** KV-cached accessor used by the /api/homepage route. */
export async function getHomePayload(
  env: Env,
  lang: Lang
): Promise<HomePayload> {
  const key = CACHE_KEYS.homepage(lang);
  const cached = await getCached<HomePayload>(env, key);
  if (cached) return cached;
  const fresh = await buildHomePayload(env, lang);
  await setCached(env, key, fresh, 3600);
  return fresh;
}
