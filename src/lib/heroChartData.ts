// Pure, deterministic data-shaping helpers for the hero CDF chart island.
//
// These functions take the JSON-serializable CurveSet the page passes to the
// island and turn it into the numeric series Chart.js consumes. They contain
// no DOM, no Chart.js, and no Date mutation beyond parsing — fully unit-tested
// in tests/unit/heroChartData.test.ts. Per CLAUDE.md, extend those tests
// before changing logic here.

/** Default forward horizon shown on the X-axis (spec §8: 24 months). */
export const DEFAULT_HORIZON_MONTHS = 24;
/** Spec §8 allows configuring the horizon up to 36 months. */
export const MAX_HORIZON_MONTHS = 36;
/** A horizon below this is meaningless for a multi-month CDF. */
export const MIN_HORIZON_MONTHS = 1;

/** One point of a probability curve or knot. Mirrors cdf.ts CDFPoint shape. */
export interface SeriesPoint {
  date: string; // ISO-8601 UTC
  probability: number; // 0–1 cumulative
  liquidity?: number; // USD (knots only)
}

/**
 * The per-definition payload the island renders. JSON-serializable so it can
 * cross the Astro island boundary (no Date objects, no functions).
 */
export interface CurveSet {
  /** Dense interpolated curve for the line. */
  curve: SeriesPoint[];
  /** Aggregated market knots the curve passes through (dot markers). */
  knots: SeriesPoint[];
  /** ISO date of the 50% crossing, or null if the curve never reaches it. */
  median: string | null;
}

/** An (x, y) sample where x is epoch-ms and y is a 0–1 probability. */
export interface XYPoint {
  x: number;
  y: number;
}

/** Everything the chart needs for one definition, ready for Chart.js. */
export interface ChartSeries {
  /** Dense monotone curve as time-scale points. */
  data: XYPoint[];
  /** Real market dates as scatter overlay points. */
  knotPoints: XYPoint[];
  /** The 50% crossing point, or null if the curve never crosses 0.5. */
  medianPoint: XYPoint | null;
  /** Epoch-ms of `today` (vertical dashed marker). */
  todayMs: number;
  /** Inclusive X-axis bounds in epoch-ms (today → today + horizon). */
  xMin: number;
  xMax: number;
}

/** Parse an ISO-8601 string to epoch-ms. Throws on an unparseable value. */
export function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`heroChartData: unparseable ISO date: ${iso}`);
  }
  return ms;
}

/**
 * Clamp a requested horizon (in months) into the spec-allowed range and round
 * to an integer. Non-finite input falls back to the 24-month default.
 */
export function clampHorizonMonths(months: number): number {
  if (!Number.isFinite(months)) return DEFAULT_HORIZON_MONTHS;
  const rounded = Math.round(months);
  if (rounded < MIN_HORIZON_MONTHS) return MIN_HORIZON_MONTHS;
  if (rounded > MAX_HORIZON_MONTHS) return MAX_HORIZON_MONTHS;
  return rounded;
}

/**
 * Add a whole number of calendar months to an epoch-ms instant, in UTC.
 * Clamps overflowing days (e.g. +1 month from Jan 31 → Feb 28/29).
 */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const daysInTarget = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(day, daysInTarget);
  return Date.UTC(
    targetYear,
    targetMonth,
    clampedDay,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds()
  );
}

/**
 * Format a 0–1 probability as a whole-percent string, e.g. 0.567 → "57%".
 * Values are clamped to [0, 1] and rounded half-up. Non-finite input → "—".
 */
export function formatPct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  const clamped = Math.min(1, Math.max(0, p));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Pick the median point to ring on the chart. Prefers the explicit `median`
 * ISO date from the CDF pipeline, reading its Y from the dense curve. If the
 * median date is absent or out of curve range, returns null.
 */
export function selectMedianPoint(
  curve: SeriesPoint[],
  median: string | null
): XYPoint | null {
  if (median == null || curve.length === 0) return null;
  const mx = isoToMs(median);
  // Exact curve sample match first (the pipeline emits dense samples).
  for (const pt of curve) {
    if (isoToMs(pt.date) === mx) {
      return { x: mx, y: clamp01(pt.probability) };
    }
  }
  // Otherwise interpolate Y linearly between the bracketing curve samples.
  for (let i = 0; i < curve.length - 1; i++) {
    const ax = isoToMs(curve[i].date);
    const bx = isoToMs(curve[i + 1].date);
    if (mx >= ax && mx <= bx) {
      const t = bx === ax ? 0 : (mx - ax) / (bx - ax);
      const y =
        clamp01(curve[i].probability) +
        t * (clamp01(curve[i + 1].probability) - clamp01(curve[i].probability));
      return { x: mx, y };
    }
  }
  // Median date is outside the curve's sampled range.
  return null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Shape a CurveSet plus a `today` ISO instant into the numeric series the
 * Chart.js island renders. Pure and deterministic.
 */
export function buildChartSeries(
  curveSet: CurveSet,
  today: string,
  horizonMonths: number = DEFAULT_HORIZON_MONTHS
): ChartSeries {
  const todayMs = isoToMs(today);
  const horizon = clampHorizonMonths(horizonMonths);
  const xMin = todayMs;

  const data: XYPoint[] = curveSet.curve.map((p) => ({
    x: isoToMs(p.date),
    y: clamp01(p.probability),
  }));

  const knotPoints: XYPoint[] = curveSet.knots.map((p) => ({
    x: isoToMs(p.date),
    y: clamp01(p.probability),
  }));

  // End at the latest data we actually have (furthest priced market), not a
  // fixed forward horizon. Fall back to the horizon only when there's no data.
  const lastData = Math.max(
    todayMs,
    ...data.map((p) => p.x),
    ...knotPoints.map((p) => p.x)
  );
  const xMax =
    lastData > todayMs ? lastData : addMonthsUtc(todayMs, horizon);

  const medianPoint = selectMedianPoint(curveSet.curve, curveSet.median);

  return { data, knotPoints, medianPoint, todayMs, xMin, xMax };
}

// --- Individual prediction markets (shown on the hero, styled per bucket) ---

/** Stable bucket keys; the page maps these to localized legend labels. */
export type MarketBucket =
  | 'ceasefireAgreement'
  | 'ceasefire'
  | 'peaceDeal'
  | 'framework'
  | 'leadership'
  | 'other';

/** Classify a market by its question text — pure, deterministic, tested. */
export function marketBucket(question: string): MarketBucket {
  const q = question.toLowerCase();
  if (q.includes('peace deal') || q.includes('peace agreement'))
    return 'peaceDeal';
  if (q.includes('framework')) return 'framework';
  if (q.includes('zelensky') || q.includes('leave president'))
    return 'leadership';
  if (q.includes('ceasefire agreement')) return 'ceasefireAgreement';
  if (q.includes('ceasefire')) return 'ceasefire';
  return 'other';
}

/** One market point for the hero scatter. JSON-serializable (island prop). */
export interface HeroMarket {
  id: string; // market_id, e.g. "polymarket:0x…" / "manifold:abc"
  x: number; // resolution date, epoch ms
  y: number; // current price, 0–1 probability
  bucket: MarketBucket;
  source: string; // platform: 'polymarket' | 'manifold'
  question: string;
  liquidity: number | null; // native amount, for the tooltip
  liquidityUnit: 'usd' | 'mana';
  history: number[]; // chronological YES prices, for the tooltip sparkline
}

/**
 * Probability → colour, for the hero curve / markers / stat cards.
 * Diverging scale: 0% red → 50% blue → 100% green. `p` is 0–1 (clamped).
 */
export function probColor(p: number): string {
  const t = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  // anchors match the palette tokens (down / accent / up)
  const RED = [181, 82, 78];
  const BLUE = [59, 107, 151];
  const GREEN = [79, 122, 82];
  const lerp = (a: number[], b: number[], k: number) =>
    a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const c =
    t <= 0.5 ? lerp(RED, BLUE, t / 0.5) : lerp(BLUE, GREEN, (t - 0.5) / 0.5);
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
