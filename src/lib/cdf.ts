// CDF computation for the war-end date.
//
// Pipeline (spec §8): raw market points → aggregate per resolution date with
// liquidity-weighted YES price → drop dates with total liquidity below the
// floor → weighted isotonic regression (Pool Adjacent Violators) for
// monotonicity → PCHIP (Fritsch–Carlson monotone cubic Hermite) interpolation
// → analytic median crossing.
//
// Unit-tested in tests/unit/cdf.test.ts. Per CLAUDE.md, add/extend those tests
// before changing any logic here.

const MS_PER_DAY = 86_400_000;

export interface CDFPoint {
  date: string; // ISO-8601
  probability: number; // 0–1 cumulative
  liquidity?: number; // USD
}

export interface CDFResult {
  /** Dense interpolated curve for plotting. */
  curve: CDFPoint[];
  /** Aggregated, monotonic market knots the curve passes through. */
  knots: CDFPoint[];
  /** ISO date of the 50% crossing, or null if the curve never reaches it. */
  median: string | null;
}

export interface CDFOptions {
  /** Drop aggregated dates whose summed liquidity is below this (USD). */
  liquidityFloorUsd?: number;
  /** Number of interpolated samples across the horizon. */
  resolution?: number;
}

const toDays = (iso: string): number => Date.parse(iso) / MS_PER_DAY;
const fromDays = (d: number): string =>
  new Date(Math.round(d) * MS_PER_DAY).toISOString();

/**
 * Group raw points by resolution date, collapsing each date to its
 * liquidity-weighted mean probability. Dates whose total liquidity is below
 * the floor are dropped. Points without liquidity are treated as weight 1 so
 * a market with no liquidity figure still contributes (but cannot meet the
 * floor on its own). Output is sorted ascending by date.
 */
export function aggregateByDate(
  points: CDFPoint[],
  liquidityFloorUsd = 10_000
): CDFPoint[] {
  const byDate = new Map<
    string,
    { wSum: number; wpSum: number; liqSum: number }
  >();
  for (const p of points) {
    const w = p.liquidity && p.liquidity > 0 ? p.liquidity : 1;
    const acc = byDate.get(p.date) ?? { wSum: 0, wpSum: 0, liqSum: 0 };
    acc.wSum += w;
    acc.wpSum += w * p.probability;
    acc.liqSum += p.liquidity ?? 0;
    byDate.set(p.date, acc);
  }
  return [...byDate.entries()]
    .filter(([, a]) => a.liqSum >= liquidityFloorUsd)
    .map(([date, a]) => ({
      date,
      probability: a.wpSum / a.wSum,
      liquidity: a.liqSum,
    }))
    .sort((p, q) => toDays(p.date) - toDays(q.date));
}

/**
 * Weighted Pool Adjacent Violators. Returns a non-decreasing fit minimizing
 * weighted squared error. Input must be sorted ascending by x. Probabilities
 * are clamped to [0, 1] after the fit.
 */
export function isotonicRegression(points: CDFPoint[]): CDFPoint[] {
  const n = points.length;
  if (n === 0) return [];

  // Active blocks: value (weighted mean), weight, and source index range.
  const val: number[] = [];
  const wgt: number[] = [];
  const idx: number[] = []; // count of original points in the block

  for (let i = 0; i < n; i++) {
    let v = points[i].probability;
    let w = points[i].liquidity && points[i].liquidity! > 0 ? points[i].liquidity! : 1;
    let c = 1;
    // Merge while the last block violates monotonicity.
    while (val.length > 0 && val[val.length - 1] > v) {
      const pv = val.pop()!;
      const pw = wgt.pop()!;
      const pc = idx.pop()!;
      v = (pv * pw + v * w) / (pw + w);
      w += pw;
      c += pc;
    }
    val.push(v);
    wgt.push(w);
    idx.push(c);
  }

  // Expand blocks back to per-point values.
  const out: CDFPoint[] = [];
  let k = 0;
  for (let b = 0; b < val.length; b++) {
    const v = Math.min(1, Math.max(0, val[b]));
    for (let j = 0; j < idx[b]; j++) {
      out.push({ ...points[k], probability: v });
      k++;
    }
  }
  return out;
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Fritsch–Carlson shape-preserving slopes for monotone cubic Hermite. */
function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const m = new Array<number>(n).fill(0);
  if (n === 1) return m;

  const h = new Array<number>(n - 1);
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = (ys[i + 1] - ys[i]) / h[i];
  }

  if (n === 2) {
    m[0] = m[1] = delta[0];
    return m;
  }

  for (let i = 1; i < n - 1; i++) {
    if (sign(delta[i - 1]) * sign(delta[i]) <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  // Non-centered three-point endpoint slopes with shape-preserving limiting.
  m[0] = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
  if (sign(m[0]) !== sign(delta[0])) {
    m[0] = 0;
  } else if (sign(delta[0]) !== sign(delta[1]) && Math.abs(m[0]) > 3 * Math.abs(delta[0])) {
    m[0] = 3 * delta[0];
  }
  const e = n - 1;
  m[e] =
    ((2 * h[e - 1] + h[e - 2]) * delta[e - 1] - h[e - 1] * delta[e - 2]) /
    (h[e - 1] + h[e - 2]);
  if (sign(m[e]) !== sign(delta[e - 1])) {
    m[e] = 0;
  } else if (
    sign(delta[e - 1]) !== sign(delta[e - 2]) &&
    Math.abs(m[e]) > 3 * Math.abs(delta[e - 1])
  ) {
    m[e] = 3 * delta[e - 1];
  }
  return m;
}

/** Evaluate the Hermite segment containing x (clamped to the knot range). */
function hermite(
  xs: number[],
  ys: number[],
  m: number[],
  x: number
): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 1 && xs[i + 1] < x) i++;
  const hI = xs[i + 1] - xs[i];
  const t = (x - xs[i]) / hI;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * ys[i] + h10 * hI * m[i] + h01 * ys[i + 1] + h11 * hI * m[i + 1]
  );
}

/**
 * PCHIP interpolation. Returns `resolution` evenly spaced samples across the
 * knot range (inclusive of both endpoints).
 */
export function pchipInterpolate(
  points: CDFPoint[],
  resolution = 200
): CDFPoint[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ ...points[0] }];

  const xs = points.map((p) => toDays(p.date));
  const ys = points.map((p) => p.probability);
  const m = pchipSlopes(xs, ys);

  const out: CDFPoint[] = [];
  const x0 = xs[0];
  const x1 = xs[n - 1];
  const steps = Math.max(2, resolution);
  for (let s = 0; s < steps; s++) {
    const x = x0 + ((x1 - x0) * s) / (steps - 1);
    out.push({
      date: fromDays(x),
      probability: Math.min(1, Math.max(0, hermite(xs, ys, m, x))),
    });
  }
  return out;
}

/**
 * Analytic crossing: find the Hermite segment whose endpoints bracket the
 * threshold and solve for x by bisection. The curve is monotone
 * non-decreasing (post isotonic), so the root is unique. Returns null if the
 * curve never reaches the threshold within the knot range.
 */
export function findCrossing(
  points: CDFPoint[],
  threshold = 0.5
): string | null {
  const n = points.length;
  if (n === 0) return null;
  if (n === 1) return points[0].probability >= threshold ? points[0].date : null;

  const xs = points.map((p) => toDays(p.date));
  const ys = points.map((p) => p.probability);
  const m = pchipSlopes(xs, ys);

  if (ys[0] >= threshold) return points[0].date;
  if (ys[n - 1] < threshold) return null;

  // Bracketing knot interval.
  let seg = 0;
  while (seg < n - 1 && ys[seg + 1] < threshold) seg++;

  let lo = xs[seg];
  let hi = xs[seg + 1];
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (hermite(xs, ys, m, mid) < threshold) lo = mid;
    else hi = mid;
  }
  return fromDays((lo + hi) / 2);
}

/** End-to-end pipeline: raw points → result with curve, knots, median date. */
export function computeCDF(
  rawPoints: CDFPoint[],
  opts: CDFOptions = {}
): CDFResult {
  const { liquidityFloorUsd = 10_000, resolution = 200 } = opts;
  const aggregated = aggregateByDate(rawPoints, liquidityFloorUsd);
  const knots = isotonicRegression(aggregated);
  const curve = pchipInterpolate(knots, resolution);
  const median = findCrossing(knots, 0.5);
  return { curve, knots, median };
}
