// Static /chart-data.json — the locale-independent chart series, built once and
// served as a single asset so the big arrays don't inline into every localized
// page's HTML. The chart islands fetch this on hydration (src/lib/chartData.ts).
//
// Output is static (astro.config `output: 'static'`), so this prerenders to a
// file at build time. The series are numbers + raw market questions only;
// localized labels stay inline on the page, so one shared file serves uk/en/ru.

import type { APIRoute } from 'astro';
import { loadHomePayload } from '@lib/homepage';
import type { ChartData } from '@lib/chartData';

export const prerender = true;

export const GET: APIRoute = () => {
  // The chart payload is locale-independent; build it from the en payload.
  const p = loadHomePayload('en');
  const body: ChartData = {
    hero: { datasets: p.hero.datasets, markets: p.hero.markets },
    consensusHistory: p.trends.consensus.points,
    history: p.history,
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
};
