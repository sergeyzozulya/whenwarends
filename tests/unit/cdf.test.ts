import { describe, it, expect } from 'vitest';
import {
  aggregateByDate,
  isotonicRegression,
  pchipInterpolate,
  findCrossing,
  computeCDF,
  type CDFPoint,
} from '../../src/lib/cdf';

// Whole-day UTC midnights so day(n) maps to an integer epoch-day, which the
// rounding in cdf's fromDays() reproduces exactly.
const day = (n: number): string =>
  new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

describe('aggregateByDate', () => {
  it('collapses same-date points to a liquidity-weighted mean', () => {
    const pts: CDFPoint[] = [
      { date: day(10), probability: 0.2, liquidity: 30_000 },
      { date: day(10), probability: 0.6, liquidity: 10_000 },
    ];
    const out = aggregateByDate(pts);
    expect(out).toHaveLength(1);
    // (0.2*30000 + 0.6*10000) / 40000 = 0.3
    expect(out[0].probability).toBeCloseTo(0.3, 10);
    expect(out[0].liquidity).toBe(40_000);
  });

  it('drops dates below the liquidity floor and sorts ascending', () => {
    const pts: CDFPoint[] = [
      { date: day(20), probability: 0.5, liquidity: 50_000 },
      { date: day(5), probability: 0.1, liquidity: 500 },
    ];
    const out = aggregateByDate(pts, 10_000);
    expect(out.map((p) => p.date)).toEqual([day(20)]);
  });
});

describe('isotonicRegression', () => {
  it('leaves an already-monotone series unchanged', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.1 },
      { date: day(1), probability: 0.4 },
      { date: day(2), probability: 0.9 },
    ];
    expect(isotonicRegression(pts).map((p) => p.probability)).toEqual([
      0.1, 0.4, 0.9,
    ]);
  });

  it('pools adjacent violators into a weighted mean', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.3 },
      { date: day(1), probability: 0.1 }, // violates
      { date: day(2), probability: 0.8 },
    ];
    const out = isotonicRegression(pts).map((p) => p.probability);
    // 0.3 and 0.1 pool to 0.2; series becomes non-decreasing.
    expect(out[0]).toBeCloseTo(0.2, 10);
    expect(out[1]).toBeCloseTo(0.2, 10);
    expect(out[2]).toBeCloseTo(0.8, 10);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });

  it('respects liquidity weights when pooling', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.4, liquidity: 90_000 },
      { date: day(1), probability: 0.0, liquidity: 10_000 },
    ];
    const out = isotonicRegression(pts).map((p) => p.probability);
    // weighted mean = (0.4*90000 + 0*10000)/100000 = 0.36
    expect(out[0]).toBeCloseTo(0.36, 10);
    expect(out[1]).toBeCloseTo(0.36, 10);
  });

  it('clamps results into [0, 1]', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 1.4 },
      { date: day(1), probability: -0.2 },
    ];
    const out = isotonicRegression(pts).map((p) => p.probability);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('pchipInterpolate', () => {
  const knots: CDFPoint[] = [
    { date: day(0), probability: 0.0 },
    { date: day(30), probability: 0.2 },
    { date: day(60), probability: 0.55 },
    { date: day(120), probability: 0.8 },
  ];

  it('returns the requested number of samples and hits the endpoints', () => {
    const curve = pchipInterpolate(knots, 100);
    expect(curve).toHaveLength(100);
    expect(curve[0].probability).toBeCloseTo(0.0, 9);
    expect(curve[curve.length - 1].probability).toBeCloseTo(0.8, 9);
  });

  it('stays monotone non-decreasing and never overshoots the knot range', () => {
    const curve = pchipInterpolate(knots, 300);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].probability).toBeGreaterThanOrEqual(
        curve[i - 1].probability - 1e-12
      );
    }
    for (const p of curve) {
      expect(p.probability).toBeGreaterThanOrEqual(0);
      expect(p.probability).toBeLessThanOrEqual(0.8 + 1e-9);
    }
  });

  it('handles a single knot', () => {
    const curve = pchipInterpolate([{ date: day(0), probability: 0.3 }]);
    expect(curve).toEqual([{ date: day(0), probability: 0.3 }]);
  });
});

describe('findCrossing', () => {
  it('finds the analytic 50% crossing of a linear ramp', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.0 },
      { date: day(100), probability: 1.0 },
    ];
    expect(findCrossing(pts, 0.5)).toBe(day(50));
  });

  it('returns the first date when the threshold is already met', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.7 },
      { date: day(10), probability: 0.9 },
    ];
    expect(findCrossing(pts, 0.5)).toBe(day(0));
  });

  it('returns null when the curve never reaches the threshold', () => {
    const pts: CDFPoint[] = [
      { date: day(0), probability: 0.1 },
      { date: day(10), probability: 0.4 },
    ];
    expect(findCrossing(pts, 0.5)).toBeNull();
  });
});

describe('computeCDF', () => {
  it('produces a monotone curve and a median within the horizon', () => {
    const raw: CDFPoint[] = [
      { date: day(0), probability: 0.05, liquidity: 40_000 },
      { date: day(90), probability: 0.35, liquidity: 60_000 },
      { date: day(180), probability: 0.62, liquidity: 50_000 },
      { date: day(365), probability: 0.82, liquidity: 30_000 },
      { date: day(180), probability: 0.40, liquidity: 20_000 }, // same-date dup
      { date: day(45), probability: 0.9, liquidity: 200 }, // below floor, dropped
    ];
    const res = computeCDF(raw);
    expect(res.knots.length).toBe(4); // day45 dropped, day180 merged
    for (let i = 1; i < res.curve.length; i++) {
      expect(res.curve[i].probability).toBeGreaterThanOrEqual(
        res.curve[i - 1].probability - 1e-12
      );
    }
    expect(res.median).not.toBeNull();
    const m = Date.parse(res.median!);
    expect(m).toBeGreaterThan(Date.parse(day(90)));
    expect(m).toBeLessThan(Date.parse(day(365)));
  });
});
