// Client/build shared contract for the prebuilt chart series.
//
// The hero CDF chart and the "war in data" timeline both render large numeric
// arrays. Inlining them as island props bloats every localized page's HTML, so
// instead we serve them once as a single, locale-independent static asset
// (/chart-data.json — see src/pages/chart-data.json.ts) and the islands fetch
// it on hydration. The series are numbers + raw market questions only; the
// localized labels stay inline on the page.
//
// This module has NO runtime imports (only erased type imports), so bundling it
// into the client islands pulls in nothing from the Node-only data layer.

import type { CurveSet, HeroMarket } from './heroChartData';
import type { HistorySeries } from './homepage';

export interface ChartData {
  hero: {
    datasets: { ceasefire: CurveSet; peaceDeal?: CurveSet; either?: CurveSet };
    markets: HeroMarket[];
  };
  /** Consensus centroid probability history (the hero tooltip sparkline). */
  consensusHistory: number[];
  /** Dense per-metric series for the "war in data" timeline. */
  history: HistorySeries[];
}

/**
 * Fetch the prebuilt chart series (client-side). `version` (the page's
 * `lastUpdated`) is a cache-bust query, so a fresh deploy serves fresh data
 * even though the asset path is stable.
 */
export async function fetchChartData(
  version: string | null
): Promise<ChartData> {
  const url = version
    ? `/chart-data.json?v=${encodeURIComponent(version)}`
    : '/chart-data.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`chart-data: HTTP ${res.status}`);
  return (await res.json()) as ChartData;
}
