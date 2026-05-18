// Hero CDF chart — an Astro island (use with client:visible on the page).
//
// Renders the cumulative-probability-that-the-war-has-ended curve with a
// definition toggle (ceasefire / formal peace deal / either), real market
// dot markers, a ringed 50% crossing with a drop-line, and a vertical dashed
// "today" marker. A keyboard-operable data table behind a toggle button is
// the screen-reader fallback (spec §11).
//
// Chart.js is imported dynamically inside an effect so it only ships when the
// island actually hydrates (spec §11: chart JS lazy-loaded). The Chart
// instance is destroyed on unmount and rebuilt on definition change.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildChartSeries,
  formatPct,
  type CurveSet,
} from '../lib/heroChartData';

const ACCENT = '#2c5aa0';
const GRID = '#e5e7eb';
const AXIS_TEXT = '#4b5563';
const MUTED = '#9ca3af';

type DefinitionKey = 'ceasefire' | 'peaceDeal' | 'either';

export interface HeroChartProps {
  datasets: {
    ceasefire: CurveSet;
    peaceDeal?: CurveSet;
    either?: CurveSet;
  };
  /** ISO-8601 UTC; vertical dashed marker and X-axis origin. */
  today: string;
  /** Pre-resolved hero.* i18n strings from the .astro page. */
  strings: Record<string, string>;
}

const DEFINITION_ORDER: DefinitionKey[] = ['ceasefire', 'peaceDeal', 'either'];

function HeroChart({ datasets, today, strings }: HeroChartProps) {
  // Only offer toggles for definitions that actually have a dataset.
  const available = useMemo<DefinitionKey[]>(
    () =>
      DEFINITION_ORDER.filter(
        (k) => datasets[k] != null
      ) as DefinitionKey[],
    [datasets]
  );

  const [active, setActive] = useState<DefinitionKey>('ceasefire');
  const [tableOpen, setTableOpen] = useState(false);

  const activeSet: CurveSet = datasets[active] ?? datasets.ceasefire;

  const series = useMemo(
    () => buildChartSeries(activeSet, today),
    [activeSet, today]
  );

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
            {
              label: strings.ceasefire ?? '',
              data: series.knotPoints,
              parsing: false,
              showLine: false,
              borderColor: ACCENT,
              backgroundColor: '#ffffff',
              pointRadius: 4,
              pointBorderWidth: 2,
              pointStyle: 'circle',
              order: 1,
            },
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
              max: series.xMax,
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
                callback: (value: number) => formatPct(value),
              },
            },
          },
          plugins: {
            legend: { display: false },
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
                label: (item: any) => formatPct(item.parsed.y),
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

  const tableRows = activeSet.knots.length
    ? activeSet.knots
    : activeSet.curve;

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

      {/* Chart. The aria-label carries the data summary; the table below is
          the navigable screen-reader fallback. */}
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

      {/* Keyboard-operable data-table fallback. */}
      <div className="mt-4">
        <button
          type="button"
          aria-expanded={tableOpen}
          aria-controls="hero-chart-table"
          onClick={() => setTableOpen((o) => !o)}
          className="text-sm font-medium text-[#2c5aa0] underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2c5aa0]"
        >
          {strings.tableToggle ?? 'Show data table'}
        </button>

        <div id="hero-chart-table" hidden={!tableOpen} className="mt-3">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              {strings.chartAria ?? strings.label ?? ''}
            </caption>
            <thead>
              <tr className="border-b border-gray-300 text-left">
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  {strings.tableDate ?? 'Date'}
                </th>
                <th scope="col" className="py-1.5 font-medium">
                  {strings.tableProbability ?? 'Probability'}
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((p) => (
                <tr key={p.date} className="border-b border-gray-100">
                  <td className="py-1.5 pr-4 font-normal">
                    {new Date(p.date).toLocaleDateString(undefined, {
                      dateStyle: 'medium',
                      timeZone: 'UTC',
                    })}
                  </td>
                  <td className="py-1.5 font-normal">
                    {formatPct(p.probability)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default HeroChart;
