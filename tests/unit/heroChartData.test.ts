import { describe, it, expect } from 'vitest';
import {
  addMonthsUtc,
  buildChartSeries,
  clampHorizonMonths,
  DEFAULT_HORIZON_MONTHS,
  formatPct,
  isoToMs,
  MAX_HORIZON_MONTHS,
  MIN_HORIZON_MONTHS,
  selectMedianPoint,
  type CurveSet,
} from '../../src/lib/heroChartData';

describe('isoToMs', () => {
  it('parses an ISO-8601 UTC instant', () => {
    expect(isoToMs('1970-01-01T00:00:00Z')).toBe(0);
    expect(isoToMs('1970-01-02T00:00:00Z')).toBe(86_400_000);
  });

  it('throws on an unparseable value', () => {
    expect(() => isoToMs('not-a-date')).toThrow(/unparseable/);
  });
});

describe('formatPct', () => {
  it('rounds to a whole percent', () => {
    expect(formatPct(0.567)).toBe('57%');
    expect(formatPct(0.564)).toBe('56%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1)).toBe('100%');
  });

  it('clamps out-of-range probabilities', () => {
    expect(formatPct(-0.2)).toBe('0%');
    expect(formatPct(1.4)).toBe('100%');
  });

  it('returns an em dash for non-finite input', () => {
    expect(formatPct(Number.NaN)).toBe('—');
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('clampHorizonMonths', () => {
  it('keeps in-range values, rounding to an integer', () => {
    expect(clampHorizonMonths(24)).toBe(24);
    expect(clampHorizonMonths(18.4)).toBe(18);
  });

  it('clamps to the spec-allowed bounds', () => {
    expect(clampHorizonMonths(0)).toBe(MIN_HORIZON_MONTHS);
    expect(clampHorizonMonths(120)).toBe(MAX_HORIZON_MONTHS);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampHorizonMonths(Number.NaN)).toBe(DEFAULT_HORIZON_MONTHS);
  });
});

describe('addMonthsUtc', () => {
  it('adds whole months in UTC', () => {
    const jan = Date.UTC(2026, 0, 15);
    expect(new Date(addMonthsUtc(jan, 24)).toISOString()).toBe(
      '2028-01-15T00:00:00.000Z'
    );
  });

  it('clamps overflowing day-of-month', () => {
    const jan31 = Date.UTC(2026, 0, 31);
    // Feb 2026 has 28 days.
    expect(new Date(addMonthsUtc(jan31, 1)).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z'
    );
  });

  it('handles leap February', () => {
    const jan31 = Date.UTC(2028, 0, 31);
    expect(new Date(addMonthsUtc(jan31, 1)).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
  });
});

describe('selectMedianPoint', () => {
  const curve = [
    { date: '2026-01-01T00:00:00Z', probability: 0.2 },
    { date: '2026-06-01T00:00:00Z', probability: 0.5 },
    { date: '2026-12-01T00:00:00Z', probability: 0.8 },
  ];

  it('returns null when the median is absent', () => {
    expect(selectMedianPoint(curve, null)).toBeNull();
  });

  it('returns null on an empty curve', () => {
    expect(selectMedianPoint([], '2026-06-01T00:00:00Z')).toBeNull();
  });

  it('uses an exact curve sample when the median lands on one', () => {
    const p = selectMedianPoint(curve, '2026-06-01T00:00:00Z');
    expect(p).not.toBeNull();
    expect(p?.x).toBe(isoToMs('2026-06-01T00:00:00Z'));
    expect(p?.y).toBeCloseTo(0.5, 10);
  });

  it('linearly interpolates Y between bracketing samples', () => {
    // Midpoint between Jan 1 (0.2) and Jun 1 (0.5).
    const mid = new Date(
      (isoToMs('2026-01-01T00:00:00Z') + isoToMs('2026-06-01T00:00:00Z')) / 2
    ).toISOString();
    const p = selectMedianPoint(curve, mid);
    expect(p).not.toBeNull();
    expect(p?.y).toBeCloseTo(0.35, 6);
  });

  it('returns null when the median date is outside the curve range', () => {
    expect(selectMedianPoint(curve, '2030-01-01T00:00:00Z')).toBeNull();
  });
});

describe('buildChartSeries', () => {
  const today = '2026-05-18T00:00:00Z';
  const curveSet: CurveSet = {
    curve: [
      { date: '2026-05-18T00:00:00Z', probability: 0.1 },
      { date: '2026-11-18T00:00:00Z', probability: 0.5 },
      { date: '2027-05-18T00:00:00Z', probability: 0.78 },
    ],
    knots: [
      { date: '2026-06-01T00:00:00Z', probability: 0.18, liquidity: 50_000 },
      { date: '2027-01-01T00:00:00Z', probability: 0.55, liquidity: 80_000 },
    ],
    median: '2026-11-18T00:00:00Z',
  };

  it('maps curve and knots to epoch-ms XY points with clamped Y', () => {
    const s = buildChartSeries(curveSet, today);
    expect(s.data).toHaveLength(3);
    expect(s.data[0]).toEqual({ x: isoToMs('2026-05-18T00:00:00Z'), y: 0.1 });
    expect(s.knotPoints).toHaveLength(2);
    expect(s.knotPoints[1].x).toBe(isoToMs('2027-01-01T00:00:00Z'));
  });

  it('sets X bounds from today across the default horizon', () => {
    const s = buildChartSeries(curveSet, today);
    expect(s.todayMs).toBe(isoToMs(today));
    expect(s.xMin).toBe(isoToMs(today));
    expect(s.xMax).toBe(addMonthsUtc(isoToMs(today), DEFAULT_HORIZON_MONTHS));
  });

  it('respects a custom (clamped) horizon', () => {
    const s = buildChartSeries(curveSet, today, 1000);
    expect(s.xMax).toBe(addMonthsUtc(isoToMs(today), MAX_HORIZON_MONTHS));
  });

  it('resolves the median point from the curve', () => {
    const s = buildChartSeries(curveSet, today);
    expect(s.medianPoint).not.toBeNull();
    expect(s.medianPoint?.y).toBeCloseTo(0.5, 10);
  });

  it('handles a missing median (curve never crosses 0.5)', () => {
    const s = buildChartSeries(
      { ...curveSet, median: null },
      today
    );
    expect(s.medianPoint).toBeNull();
  });

  it('clamps out-of-range curve probabilities into [0, 1]', () => {
    const s = buildChartSeries(
      {
        curve: [
          { date: '2026-05-18T00:00:00Z', probability: -0.3 },
          { date: '2026-06-18T00:00:00Z', probability: 1.5 },
        ],
        knots: [],
        median: null,
      },
      today
    );
    expect(s.data[0].y).toBe(0);
    expect(s.data[1].y).toBe(1);
  });
});
