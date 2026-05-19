// Shared editorial-brief context: the standing source allow-list, plus the
// point-in-time metric reconstruction used to backfill historical briefs and
// to render the inline brief timeline.
//
// "As of date X" means: for each metric/source, the latest snapshot whose ts
// is on or before X. snapshots.ndjson is the only historical store (markets
// .json is current-only), so a reconstructed brief is grounded strictly in
// what the archive recorded by that date — never fabricated, never
// forward-looking. Numbers that have no snapshot at or before X are null and
// stated as "not available", same honesty rule as the live path.

import type { Citation, SnapshotRow } from './types';

/**
 * Standing data provenance. A brief — live or reconstructed — may cite only
 * these URLs (plus event source URLs); llm.ts enforces the allow-list.
 */
export const DATA_SOURCES: Citation[] = [
  {
    source: 'Polymarket',
    url: 'https://polymarket.com',
    title: 'Market-implied war-end probabilities',
  },
  {
    source: 'Manifold Markets',
    url: 'https://manifold.markets',
    title: 'Secondary forecast market',
  },
  {
    source: 'GDELT Project',
    url: 'https://www.gdeltproject.org',
    title: 'Conflict intensity and tone',
  },
  {
    source: 'Kiel Institute Ukraine Support Tracker',
    url: 'https://www.ifw-kiel.de/topics/war-against-ukraine/ukraine-support-tracker/',
    title: 'Aid commitments',
  },
  {
    source: 'National Bank of Ukraine',
    url: 'https://bank.gov.ua',
    title: 'UAH exchange rate',
  },
  {
    source: 'Central Bank of Russia',
    url: 'https://www.cbr.ru',
    title: 'RUB exchange rate',
  },
  {
    source: 'World Bank',
    url: 'https://data.worldbank.org/country/russian-federation',
    title: 'Russian macro indicators',
  },
  {
    source: 'NASA FIRMS',
    url: 'https://firms.modaps.eosdis.nasa.gov',
    title: 'Fire/heat anomalies',
  },
];

/** Reconstructed point-in-time metrics. `null` = no snapshot by `asOf`. */
export interface AsOfMetrics {
  /** The ISO date (inclusive upper bound) this snapshot of reality is for. */
  asOf: string;
  /** Latest war-end probability (0–1) per forecast source, at-or-before asOf. */
  warEndProbability: { source: string; value: number }[];
  conflictIntensity: number | null;
  aidEur: number | null;
  rubUsd: number | null;
  uahUsd: number | null;
  fireAnomalies: number | null;
}

/** Latest snapshot value for (metric, source) with ts <= asOfIso, or null. */
function latestAtOrBefore(
  rows: SnapshotRow[],
  metric: string,
  source: string,
  asOfIso: string
): number | null {
  let best: SnapshotRow | null = null;
  for (const r of rows) {
    if (r.metric !== metric || r.source !== source) continue;
    if (r.ts > asOfIso) continue;
    if (r.value === null) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best ? best.value : null;
}

/** Distinct sources that reported `metric` at or before `asOfIso`. */
function sourcesFor(
  rows: SnapshotRow[],
  metric: string,
  asOfIso: string
): string[] {
  const s = new Set<string>();
  for (const r of rows) {
    if (r.metric === metric && r.ts <= asOfIso && r.value !== null) {
      s.add(r.source);
    }
  }
  return [...s].sort();
}

/** Reconstruct the metric picture as it stood on `asOfIso` (inclusive). */
export function asOfMetrics(
  rows: SnapshotRow[],
  asOfIso: string
): AsOfMetrics {
  const warEndProbability: { source: string; value: number }[] = [];
  for (const source of sourcesFor(rows, 'war_end_probability', asOfIso)) {
    const v = latestAtOrBefore(rows, 'war_end_probability', source, asOfIso);
    if (v !== null) warEndProbability.push({ source, value: v });
  }
  return {
    asOf: asOfIso,
    warEndProbability,
    conflictIntensity: latestAtOrBefore(
      rows,
      'conflict_intensity',
      'gdelt',
      asOfIso
    ),
    aidEur: latestAtOrBefore(rows, 'aid_commitments_eur', 'kiel', asOfIso),
    rubUsd: latestAtOrBefore(rows, 'rub_usd_rate', 'cbr', asOfIso),
    uahUsd: latestAtOrBefore(rows, 'uah_usd_rate', 'nbu', asOfIso),
    fireAnomalies: latestAtOrBefore(rows, 'fire_anomalies', 'firms', asOfIso),
  };
}

const pct = (p: number): string => `${(p * 100).toFixed(0)}%`;
const eur0 = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

/**
 * Render the as-of metrics as the factual context block for the LLM. Mirrors
 * the live `buildDataContext` phrasing so reconstructed and live briefs read
 * consistently. States missing data plainly; never invents a number.
 */
export function formatHistoricalContext(m: AsOfMetrics): string {
  const lines: string[] = [
    `Reconstruction date (UTC, inclusive): ${m.asOf.slice(0, 10)}.`,
    'These are the latest values archived on or before that date — a' +
      ' point-in-time reconstruction, not a forecast.',
  ];
  if (m.warEndProbability.length) {
    for (const w of m.warEndProbability) {
      lines.push(
        `Market "${w.source}" war-end probability: ${pct(w.value)}.`
      );
    }
  } else {
    lines.push('Market-implied war-end probability: not available by this date.');
  }
  const ind = (label: string, v: number | null, fmt: (n: number) => string) =>
    lines.push(`${label}: ${v === null ? 'not available by this date' : fmt(v)}.`);
  ind('Conflict intensity (GDELT volume index)', m.conflictIntensity, (v) =>
    v.toFixed(1)
  );
  ind('Aid commitments', m.aidEur, (v) => eur0.format(v));
  ind('Russian economy (RUB/USD)', m.rubUsd, (v) => `${v.toFixed(2)} RUB / USD`);
  ind('Ukrainian economy (UAH/USD)', m.uahUsd, (v) => `${v.toFixed(2)} UAH / USD`);
  ind('Fire/heat anomalies (NASA FIRMS)', m.fireAnomalies, (v) =>
    String(Math.round(v))
  );
  lines.push('No editorial events are attached to this reconstructed period.');
  return lines.join('\n');
}
