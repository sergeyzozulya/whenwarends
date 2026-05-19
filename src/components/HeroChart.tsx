// Hero CDF chart — an Astro island (use with client:visible on the page).
//
// Renders the cumulative-probability-that-the-war-has-ended curve with a
// definition toggle (ceasefire / formal peace deal / either), real market
// dot markers, a ringed 50% crossing with a drop-line, and a vertical dashed
// "today" marker. The chart's aria-label carries a text data summary for
// screen readers.
//
// Chart.js is imported dynamically inside an effect so it only ships when the
// island actually hydrates (spec §11: chart JS lazy-loaded). The Chart
// instance is destroyed on unmount and rebuilt on definition change.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildChartSeries,
  formatPct,
  type CurveSet,
  type HeroMarket,
  type MarketBucket,
} from '../lib/heroChartData';

const ACCENT = '#2c5aa0';
const GRID = '#e5e7eb';
const AXIS_TEXT = '#4b5563';
const MUTED = '#9ca3af';

// Per-bucket colour + point shape. CLAUDE.md prefers a single accent, but the
// operator explicitly asked for distinct style/colour per market type; this
// is a restrained qualitative palette + varied point shapes so buckets stay
// distinguishable even in greyscale.
const BUCKET_ORDER: MarketBucket[] = [
  'ceasefireAgreement',
  'ceasefire',
  'peaceDeal',
  'framework',
  'leadership',
  'other',
];
const BUCKET_STYLE: Record<
  MarketBucket,
  { color: string; pointStyle: string }
> = {
  ceasefireAgreement: { color: '#2c5aa0', pointStyle: 'circle' },
  ceasefire: { color: '#5b8def', pointStyle: 'triangle' },
  peaceDeal: { color: '#2e7d5b', pointStyle: 'rect' },
  framework: { color: '#b5651d', pointStyle: 'rectRot' },
  leadership: { color: '#7a5ea8', pointStyle: 'star' },
  other: { color: '#6b7280', pointStyle: 'crossRot' },
};

type DefinitionKey = 'ceasefire' | 'peaceDeal' | 'either';

export interface HeroChartProps {
  datasets: {
    ceasefire: CurveSet;
    peaceDeal?: CurveSet;
    either?: CurveSet;
  };
  /** ISO-8601 UTC; vertical dashed marker and X-axis origin. */
  today: string;
  /** Individual prediction markets, plotted distinctly over the curve. */
  markets: HeroMarket[];
  /** Pre-resolved hero.* i18n strings from the .astro page. */
  strings: Record<string, string>;
}

const DEFINITION_ORDER: DefinitionKey[] = ['ceasefire', 'peaceDeal', 'either'];

function HeroChart({ datasets, today, markets, strings }: HeroChartProps) {
  // Only offer toggles for definitions that actually have a dataset.
  const available = useMemo<DefinitionKey[]>(
    () =>
      DEFINITION_ORDER.filter(
        (k) => datasets[k] != null
      ) as DefinitionKey[],
    [datasets]
  );

  const [active, setActive] = useState<DefinitionKey>('ceasefire');

  const activeSet: CurveSet = datasets[active] ?? datasets.ceasefire;

  const series = useMemo(
    () => buildChartSeries(activeSet, today),
    [activeSet, today]
  );

  // One Chart.js scatter dataset per market bucket present, distinctly
  // styled. Each point carries the raw market for the tooltip.
  const marketDatasets = useMemo(() => {
    return BUCKET_ORDER.filter((b) =>
      markets.some((m) => m.bucket === b)
    ).map((b) => {
      const st = BUCKET_STYLE[b];
      return {
        isMarket: true,
        label: strings[`bkt_${b}`] ?? b,
        data: markets
          .filter((m) => m.bucket === b)
          .map((m) => ({
            x: m.x,
            y: m.y,
            q: m.question,
            src: m.source,
            liq: m.liquidity,
          })),
        parsing: false,
        showLine: false,
        borderColor: st.color,
        backgroundColor: st.color,
        pointStyle: st.pointStyle,
        pointRadius: 5,
        pointHoverRadius: 7,
        order: 1,
      };
    });
  }, [markets, strings]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Chart.js has no ambient types available in this project; the instance is
  // held loosely and only ever .update()/.destroy()'d. Justified `any`:
  // chart.js types are not part of the strict graph here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      if (cancelled || !canvasRef.current) return;

      const dropLine =
        series.medianPoint != null
          ? [
              { x: series.medianPoint.x, y: 0 },
              { x: series.medianPoint.x, y: series.medianPoint.y },
            ]
          : [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = {
        type: 'line',
        data: {
          datasets: [
            {
              label: strings.label ?? '',
              data: series.data,
              parsing: false,
              borderColor: ACCENT,
              backgroundColor: 'transparent',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0,
              order: 3,
            },
            {
              label: strings.crossing50 ?? '',
              data: dropLine,
              parsing: false,
              borderColor: MUTED,
              borderWidth: 1,
              borderDash: [3, 3],
              pointRadius: 0,
              order: 2,
            },
            ...marketDatasets,
            {
              label: strings.crossing50 ?? '',
              data: series.medianPoint ? [series.medianPoint] : [],
              parsing: false,
              showLine: false,
              borderColor: ACCENT,
              backgroundColor: '#ffffff',
              pointRadius: 7,
              pointBorderWidth: 3,
              pointStyle: 'circle',
              order: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          // No flashing/animated numbers (CLAUDE.md).
          animation: false,
          interaction: { mode: 'nearest', intersect: false },
          scales: {
            x: {
              type: 'linear',
              min: series.xMin,
              // Pad the right edge by ~4% of the span so the latest
              // marker/point doesn't sit flush against the axis.
              max:
                series.xMax + (series.xMax - series.xMin) * 0.04,
              grid: { color: GRID, drawTicks: false },
              border: { color: GRID },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 13, weight: 400 },
                maxRotation: 0,
                autoSkipPadding: 24,
                callback: (value: number) =>
                  new Date(value).toLocaleDateString(undefined, {
                    month: 'short',
                    year: 'numeric',
                    timeZone: 'UTC',
                  }),
              },
            },
            y: {
              min: 0,
              max: 1,
              grid: { color: GRID, drawTicks: false },
              border: { color: GRID },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 13, weight: 400 },
                stepSize: 0.2,
                // Hide the 0% tick: it sits in the bottom corner and
                // collides with the first date label on the x-axis.
                callback: (value: number) =>
                  value === 0 ? '' : formatPct(value),
              },
            },
            // Mirror of `y` on the right edge — same scale, labels only.
            // No dataset binds to it (datasets use the default `y`); grid is
            // suppressed so gridlines aren't drawn twice.
            y1: {
              display: true,
              position: 'right',
              min: 0,
              max: 1,
              grid: { display: false },
              border: { color: GRID },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 13, weight: 400 },
                stepSize: 0.2,
                // Hide the 0% tick: it sits in the bottom corner and
                // collides with the first date label on the x-axis.
                callback: (value: number) =>
                  value === 0 ? '' : formatPct(value),
              },
            },
          },
          plugins: {
            // Legend explains the per-bucket styling; show only the market
            // bucket datasets (skip the curve / drop-line / median entries).
            legend: {
              display: true,
              position: 'bottom',
              labels: {
                usePointStyle: true,
                color: AXIS_TEXT,
                font: { size: 13, weight: 400 },
                // Only the per-bucket market datasets carry `isMarket`.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                filter: (li: any, data: any) =>
                  data.datasets[li.datasetIndex]?.isMarket === true,
              },
            },
            tooltip: {
              displayColors: false,
              callbacks: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                title: (items: any[]) =>
                  items.length
                    ? new Date(items[0].parsed.x).toLocaleDateString(
                        undefined,
                        { dateStyle: 'medium', timeZone: 'UTC' }
                      )
                    : '',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                label: (item: any) => {
                  const r = item.raw ?? {};
                  const pct = formatPct(item.parsed.y);
                  return r.q ? `${pct} — ${r.q}` : pct;
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                afterLabel: (item: any) => {
                  const r = item.raw ?? {};
                  if (!r.q) return '';
                  const liq =
                    typeof r.liq === 'number'
                      ? ` · $${Math.round(r.liq).toLocaleString()}`
                      : '';
                  return `${r.src ?? ''}${liq}`;
                },
              },
            },
          },
        },
      };

      chartRef.current = new Chart(canvas, config);
    })();

    return () => {
      cancelled = true;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [series, strings]);

  const todayLabel = new Date(series.todayMs).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

  return (
    <div className="w-full">
      {/* Definition toggle: segmented control. */}
      {available.length > 1 && (
        <div
          role="group"
          aria-label={strings.definition ?? 'Definition'}
          className="mb-4 inline-flex rounded border border-gray-300"
        >
          {available.map((key, i) => {
            const isActive = key === active;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isActive}
                onClick={() => setActive(key)}
                className={[
                  'px-3 py-1.5 text-sm font-normal focus:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-[#2c5aa0]',
                  i > 0 ? 'border-l border-gray-300' : '',
                  isActive
                    ? 'bg-[#2c5aa0] text-white font-medium'
                    : 'bg-white text-gray-700 hover:bg-gray-50',
                ].join(' ')}
              >
                {strings[key] ?? key}
              </button>
            );
          })}
        </div>
      )}

      {/* Chart. The aria-label carries the text data summary for SR users. */}
      <div
        role="img"
        aria-label={strings.chartAria ?? strings.label ?? ''}
        className="relative h-72 w-full sm:h-96"
      >
        <canvas ref={canvasRef} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>
          {(strings.todayMarker ?? 'Today')}: {todayLabel}
        </span>
        {activeSet.median && (
          <span>
            {(strings.median ?? 'Median expected end date')}:{' '}
            {new Date(activeSet.median).toLocaleDateString(undefined, {
              dateStyle: 'medium',
              timeZone: 'UTC',
            })}
          </span>
        )}
      </div>

    </div>
  );
}

export default HeroChart;
