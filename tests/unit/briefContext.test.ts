import { describe, it, expect } from 'vitest';
import {
  asOfMetrics,
  formatHistoricalContext,
  DATA_SOURCES,
} from '../../src/lib/briefContext';
import type { SnapshotRow } from '../../src/lib/types';

let id = 0;
const snap = (
  metric: string,
  source: string,
  ts: string,
  value: number | null
): SnapshotRow => ({
  id: ++id,
  metric,
  source,
  ts,
  value,
  raw_blob: null,
  confidence: null,
});

const rows: SnapshotRow[] = [
  snap('war_end_probability', 'polymarket', '2025-01-15T00:00:00Z', 0.1),
  snap('war_end_probability', 'polymarket', '2025-06-10T00:00:00Z', 0.42),
  // a later point that must be EXCLUDED for an as-of of 2025-06-30
  snap('war_end_probability', 'polymarket', '2025-09-01T00:00:00Z', 0.55),
  snap('war_end_probability', 'manifold', '2025-05-01T00:00:00Z', 0.38),
  snap('conflict_intensity', 'gdelt', '2025-06-20T00:00:00Z', 7.3),
  snap('aid_commitments_eur', 'kiel', '2025-04-01T00:00:00Z', 1.2e11),
  snap('rub_usd_rate', 'cbr', '2025-06-29T00:00:00Z', 92.4),
  // a null-valued snapshot must never be picked
  snap('uah_usd_rate', 'nbu', '2025-06-15T00:00:00Z', null),
];

describe('asOfMetrics', () => {
  it('takes the latest value at or before the as-of bound, per source', () => {
    const m = asOfMetrics(rows, '2025-06-30T23:59:59.999Z');
    expect(m.warEndProbability).toEqual([
      { source: 'manifold', value: 0.38 },
      { source: 'polymarket', value: 0.42 }, // 0.55 is after the bound
    ]);
    expect(m.conflictIntensity).toBe(7.3);
    expect(m.aidEur).toBe(1.2e11);
    expect(m.rubUsd).toBe(92.4);
  });

  it('returns null for metrics with no snapshot by the as-of date', () => {
    const m = asOfMetrics(rows, '2025-02-01T00:00:00Z');
    expect(m.conflictIntensity).toBeNull(); // first gdelt point is in June
    expect(m.aidEur).toBeNull();
    expect(m.warEndProbability).toEqual([
      { source: 'polymarket', value: 0.1 },
    ]);
  });

  it('never selects a null-valued snapshot', () => {
    const m = asOfMetrics(rows, '2025-12-31T00:00:00Z');
    expect(m.uahUsd).toBeNull();
  });

  it('is empty when nothing precedes the as-of date', () => {
    const m = asOfMetrics(rows, '2020-01-01T00:00:00Z');
    expect(m.warEndProbability).toEqual([]);
    expect(m.conflictIntensity).toBeNull();
    expect(m.rubUsd).toBeNull();
  });
});

describe('formatHistoricalContext', () => {
  it('renders values and flags missing data plainly, never fabricating', () => {
    const text = formatHistoricalContext(
      asOfMetrics(rows, '2025-06-30T23:59:59.999Z')
    );
    expect(text).toContain('Reconstruction date (UTC, inclusive): 2025-06-30');
    expect(text).toContain('point-in-time reconstruction, not a forecast');
    expect(text).toContain('"polymarket" war-end probability: 42%');
    expect(text).toContain('Conflict intensity (GDELT volume index): 7.3');
  });

  it('says "not available by this date" for absent metrics', () => {
    const text = formatHistoricalContext(
      asOfMetrics(rows, '2025-02-01T00:00:00Z')
    );
    expect(text).toContain('Aid commitments: not available by this date');
    expect(text).toMatch(/war-end probability.*not available|"polymarket"/);
  });
});

describe('DATA_SOURCES allow-list', () => {
  it('every source has a non-empty source name and a valid https url', () => {
    expect(DATA_SOURCES.length).toBeGreaterThan(0);
    for (const c of DATA_SOURCES) {
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.url).toMatch(/^https:\/\//);
    }
  });
});
