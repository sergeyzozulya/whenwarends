// Hero CDF chart — an Astro island (client:load on the page).
//
// Cumulative-probability-that-the-war-has-ended curve with a light area
// fill, hollow market-resolution markers, a ringed 50% crossing with a
// drop-line, and a dashed "today" marker. Editorial palette (one muted-blue
// accent, warm hairlines). Chart.js is imported dynamically so it only
// ships when the island hydrates.

import { useEffect, useMemo, useRef } from 'react';
import {
  buildChartSeries,
  formatPct,
  probColor,
  type CurveSet,
  type HeroMarket,
} from '../lib/heroChartData';

const ACCENT = '#3b6b97';
const FILL = 'rgba(59,107,151,0.10)';
const LINE = '#dcdcd6';
const AXIS_TEXT = '#9b9b96';
const MUTED = '#b7b8b1';
const SURFACE = '#ffffff';

export interface HeroChartProps {
  datasets: {
    ceasefire: CurveSet;
    peaceDeal?: CurveSet;
    either?: CurveSet;
  };
  today: string;
  markets: HeroMarket[];
  strings: Record<string, string>;
}

function HeroChart({ datasets, today, markets, strings }: HeroChartProps) {
  const series = useMemo(
    () => buildChartSeries(datasets.ceasefire, today),
    [datasets, today]
  );

  const marketPoints = useMemo(
    () => markets.map((m) => ({ x: m.x, y: m.y, q: m.question, src: m.source, liq: m.liquidity })),
    [markets]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
      const todayLine = [
        { x: series.todayMs, y: 0 },
        { x: series.todayMs, y: 1 },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'curve',
              data: series.data,
              parsing: false,
              // diverging by probability: 0% red → 50% blue → 100% green
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              borderColor: (c: any) => {
                const ch = c.chart;
                const area = ch.chartArea;
                if (!area || !ch.scales?.y) return ACCENT;
                const g = ch.ctx.createLinearGradient(
                  0,
                  ch.scales.y.getPixelForValue(0),
                  0,
                  ch.scales.y.getPixelForValue(1)
                );
                g.addColorStop(0, probColor(0));
                g.addColorStop(0.5, probColor(0.5));
                g.addColorStop(1, probColor(1));
                return g;
              },
              backgroundColor: FILL,
              borderWidth: 2,
              fill: 'origin',
              pointRadius: 0,
              tension: 0,
              order: 4,
            },
            {
              label: 'today',
              data: todayLine,
              parsing: false,
              borderColor: MUTED,
              borderWidth: 1,
              borderDash: [2, 3],
              pointRadius: 0,
              order: 3,
            },
            {
              label: 'crossing',
              data: dropLine,
              parsing: false,
              borderColor: ACCENT,
              borderWidth: 1,
              borderDash: [3, 3],
              pointRadius: 0,
              order: 2,
            },
            {
              label: 'markets',
              data: marketPoints,
              parsing: false,
              showLine: false,
              pointBorderColor: marketPoints.map((m) => probColor(m.y)),
              pointBackgroundColor: 'transparent',
              pointStyle: 'circle',
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBorderWidth: 1.5,
              order: 1,
            },
            {
              label: 'median',
              data: series.medianPoint ? [series.medianPoint] : [],
              parsing: false,
              showLine: false,
              pointBorderColor: series.medianPoint
                ? probColor(series.medianPoint.y)
                : ACCENT,
              backgroundColor: SURFACE,
              pointBackgroundColor: SURFACE,
              pointRadius: 6,
              pointBorderWidth: 3,
              pointStyle: 'circle',
              order: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'nearest', intersect: false },
          scales: {
            x: {
              type: 'linear',
              min: series.xMin,
              max: series.xMax + (series.xMax - series.xMin) * 0.04,
              grid: { color: LINE, drawTicks: false },
              border: { color: LINE },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 12, weight: 400 },
                maxRotation: 0,
                autoSkipPadding: 28,
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
              grid: { color: LINE, drawTicks: false },
              border: { color: LINE },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 12, weight: 400 },
                stepSize: 0.25,
                callback: (value: number) =>
                  value === 0 ? '' : formatPct(value),
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              displayColors: false,
              backgroundColor: '#22262b',
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

      const crossingLabel = series.medianPoint
        ? `${strings.legendCrossing ?? '50% crossing'} · ${new Date(
            series.medianPoint.x
          ).toLocaleDateString(undefined, {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })}`
        : '';
      const todayText = strings.todayMarker ?? 'today';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const annPlugin: any = {
        id: 'ann',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        afterDatasetsDraw(chart: any) {
          const { ctx, chartArea, scales } = chart;
          ctx.save();
          ctx.font =
            '12px ui-monospace, SFMono-Regular, Menlo, monospace';
          // "today"
          const tx = scales.x.getPixelForValue(series.todayMs);
          if (tx >= chartArea.left && tx <= chartArea.right) {
            ctx.fillStyle = AXIS_TEXT;
            ctx.textAlign = 'left';
            ctx.fillText(todayText, tx + 4, chartArea.top + 12);
          }
          // "50% crossing · Mon Year"
          if (series.medianPoint && crossingLabel) {
            const mx = scales.x.getPixelForValue(series.medianPoint.x);
            const my = scales.y.getPixelForValue(series.medianPoint.y);
            ctx.fillStyle = ACCENT;
            ctx.textAlign = mx > chartArea.right - 140 ? 'right' : 'left';
            const ox = mx > chartArea.right - 140 ? -10 : 12;
            ctx.fillText(crossingLabel, mx + ox, my - 10);
          }
          ctx.restore();
        },
      };
      config.plugins = [annPlugin];

      Chart.getChart(canvas)?.destroy();
      chartRef.current = new Chart(canvas, config);
    })();

    return () => {
      cancelled = true;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [series, marketPoints]);

  const legend: { label: string; kind: 'line' | 'ring' | 'dash' | 'dot' }[] = [
    { label: strings.legendCurve ?? 'Consensus CDF', kind: 'line' },
    { label: strings.legendMarket ?? 'Market resolution date', kind: 'ring' },
    { label: strings.legendCrossing ?? '50% crossing', kind: 'dot' },
    { label: strings.todayMarker ?? 'Today', kind: 'dash' },
  ];

  return (
    <div className="w-full">

      <div
        role="img"
        aria-label={strings.chartAria ?? ''}
        className="relative h-[300px] w-full sm:h-[386px]"
      >
        <canvas ref={canvasRef} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[var(--color-line)] pt-4 text-[13px] text-[var(--color-muted)]">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-2">
              <svg width="22" height="10" aria-hidden="true">
                {l.kind === 'line' && (
                  <line x1="0" y1="5" x2="22" y2="5" stroke={ACCENT} strokeWidth="2" />
                )}
                {l.kind === 'dash' && (
                  <line x1="0" y1="5" x2="22" y2="5" stroke={MUTED} strokeWidth="1" strokeDasharray="2 3" />
                )}
                {l.kind === 'ring' && (
                  <circle cx="11" cy="5" r="3.5" fill="none" stroke={ACCENT} strokeWidth="1.5" />
                )}
                {l.kind === 'dot' && (
                  <circle cx="11" cy="5" r="4" fill={SURFACE} stroke={ACCENT} strokeWidth="2.5" />
                )}
              </svg>
              {l.label}
            </span>
          ))}
        </div>
        {strings.nMarkets && (
          <span className="text-[var(--color-faint)]">{strings.nMarkets}</span>
        )}
      </div>
    </div>
  );
}

export default HeroChart;
