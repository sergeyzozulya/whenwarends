// Hero CDF chart — an Astro island (client:load on the page).
//
// Cumulative-probability-that-the-war-has-ended curve with a light area fill
// and hollow market-resolution markers from BOTH sources. Three selections are
// marked with colour-coded icons drawn on the canvas: closest (clock),
// consensus (average glyph), optimistic (star). A custom HTML tooltip shows
// each point's details plus a mini history sparkline — including the consensus
// mark. Chart.js is imported dynamically so it only ships when the island
// hydrates.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildChartSeries,
  formatPct,
  probColor,
  type CurveSet,
  type HeroMarket,
} from '../lib/heroChartData';
import { fetchChartData, type ChartData } from '../lib/chartData';
import { OPTIMISTIC_PATH, OPTIMISTIC_VIEWBOX, AVERAGE_PATH } from '../lib/icons';

const ACCENT = '#3b6b97';
const FILL = 'rgba(59,107,151,0.10)';
const LINE = '#dcdcd6';
const AXIS_TEXT = '#9b9b96';
const TODAY_LINE = '#b7b8b1';

export interface HeroChartProps {
  datasets: { ceasefire: CurveSet; peaceDeal?: CurveSet; either?: CurveSet };
  today: string;
  markets: HeroMarket[];
  /** Consensus centroid: epoch-ms x, 0–1 y, and its probability history. */
  consensus: { x: number; y: number; history: number[] } | null;
  closestId: string | null;
  optimisticId: string | null;
  strings: Record<string, string>;
}

interface MarketPoint {
  x: number;
  y: number;
  id: string;
  q: string;
  src: string;
  liq: number | null;
  liqUnit: 'usd' | 'mana';
  history: number[];
  r: number; // dot radius, sized by market liquidity
}

// Regular market dots scale with liquidity (area ∝ liquidity, sqrt of radius),
// normalized within each source so play-money Manifold stays visible next to
// real-money Polymarket. The three labelled marks are drawn larger (below).
const DOT_MIN_R = 3;
const DOT_MAX_R = 8;

const fmtLiq = (v: number | null, unit: 'usd' | 'mana'): string => {
  if (v == null || !Number.isFinite(v)) return '';
  if (unit === 'mana') return `${Math.round(v).toLocaleString()} mana`;
  if (v >= 1000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
};

const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

/** Inline-SVG sparkline markup for the tooltip (from a point's history). */
function sparklineSvg(history: number[]): string {
  const w = 132;
  const h = 30;
  const pad = 2;
  const pts = (history ?? []).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return '';
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min;
  const n = pts.length;
  const coords = pts.map((v, i) => {
    const x = pad + (i / (n - 1)) * (w - pad * 2);
    const t = range === 0 ? 0.5 : (v - min) / range;
    const y = pad + (h - pad * 2) - t * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `style="display:block;margin-top:4px">` +
    `<polyline points="${coords.join(' ')}" fill="none" stroke="${ACCENT}" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

// --- canvas icon drawing (colour-coded by the point's probability) ---
// A white disc sits behind each mark so it reads cleanly over the curve, grid,
// and overlapping market dots. Kept larger than DOT_MAX_R so the three
// selections always read bigger than any liquidity-sized market dot.
const MARK_DISC_R = 12;

function whiteDisc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number = MARK_DISC_R
): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Hover grows the mark (disc + icon), mirroring the dots' pointHoverRadius.
const HOVER_DISC_R = 14;

function drawClock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  hover: boolean
): void {
  const r = hover ? 11 : 9;
  whiteDisc(ctx, x, y, hover ? HOVER_DISC_R : MARK_DISC_R);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - r * 0.6);
  ctx.moveTo(x, y);
  ctx.lineTo(x + r * 0.5, y);
  ctx.stroke();
  ctx.restore();
}

function drawStrokedIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  hover: boolean,
  baseSize: number,
  lineWidth: number,
  paths: string[]
): void {
  const S = hover ? baseSize + 4 : baseSize;
  whiteDisc(ctx, x, y, hover ? HOVER_DISC_R : MARK_DISC_R);
  ctx.save();
  ctx.translate(x - S / 2, y - S / 2);
  ctx.scale(S / 24, S / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  hover: boolean
): void {
  const S = hover ? 28 : 24;
  whiteDisc(ctx, x, y, hover ? HOVER_DISC_R : MARK_DISC_R);
  ctx.save();
  ctx.translate(x - S / 2, y - S / 2);
  ctx.scale(S / OPTIMISTIC_VIEWBOX, S / OPTIMISTIC_VIEWBOX);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(OPTIMISTIC_PATH));
  ctx.restore();
}

function drawAverage(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  hover: boolean
): void {
  drawStrokedIcon(ctx, x, y, color, hover, 22, 2, [AVERAGE_PATH]);
}

function HeroChartView({
  datasets,
  today,
  markets,
  consensus,
  closestId,
  optimisticId,
  strings,
}: HeroChartProps) {
  const series = useMemo(
    () => buildChartSeries(datasets.ceasefire, today),
    [datasets, today]
  );

  const marketPoints: MarketPoint[] = useMemo(() => {
    const maxBySource = new Map<string, number>();
    for (const m of markets) {
      const liq = m.liquidity ?? 0;
      maxBySource.set(m.source, Math.max(maxBySource.get(m.source) ?? 0, liq));
    }
    return markets.map((m) => {
      const maxLiq = maxBySource.get(m.source) ?? 0;
      const liq = m.liquidity ?? 0;
      const r =
        maxLiq > 0
          ? Math.max(DOT_MIN_R, Math.min(DOT_MAX_R, DOT_MAX_R * Math.sqrt(liq / maxLiq)))
          : DOT_MIN_R;
      return {
        x: m.x,
        y: m.y,
        id: m.id,
        q: m.question,
        src: m.source,
        liq: m.liquidity,
        liqUnit: m.liquidityUnit,
        history: m.history,
        r,
      };
    });
  }, [markets]);

  // Y-axis tops out just above the highest plotted value (a CDF that asymptotes
  // well under 100% should not waste half the chart on empty space).
  const yMax = useMemo(() => {
    const ys = [
      ...series.data.map((p) => p.y),
      ...marketPoints.map((m) => m.y),
    ];
    if (consensus) ys.push(consensus.y);
    const m = ys.length ? Math.max(...ys) : 1;
    return Math.min(1, Math.max(0.1, m + 0.06));
  }, [series, marketPoints, consensus]);

  // X-axis fits the data edge-to-edge — no padding before the first point or
  // after the last (the curve's first/last knots are the extreme markets).
  const [xMin, xMax] = useMemo(() => {
    const xs = [
      ...series.data.map((p) => p.x),
      ...marketPoints.map((m) => m.x),
    ];
    if (consensus) xs.push(consensus.x);
    if (xs.length === 0) return [series.xMin, series.xMax];
    const dataMax = Math.max(...xs);
    const left = Math.min(series.todayMs, ...xs);
    // Small left margin so the "today" line is a visible vertical rule rather
    // than merging with the axis (today sits just before the first market).
    // The right edge stays tight to the last market — no trailing gap.
    const margin = (dataMax - left) * 0.05;
    return [left - margin, dataMax];
  }, [series, marketPoints, consensus]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
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

      const todayLine = [
        { x: series.todayMs, y: 0 },
        { x: series.todayMs, y: yMax },
      ];
      const consensusPoint = consensus
        ? [{ x: consensus.x, y: consensus.y, kind: 'consensus', history: consensus.history }]
        : [];

      const consensusLabel = strings.consensusLabel ?? 'Consensus';
      const consensusMeta = strings.consensusMeta ?? '';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const externalTooltip = (ctx: any) => {
        const el = tooltipRef.current;
        if (!el) return;
        const tt = ctx.tooltip;
        if (!tt || tt.opacity === 0) {
          el.style.opacity = '0';
          return;
        }
        const raw = tt.dataPoints?.[0]?.raw;
        if (!raw) {
          el.style.opacity = '0';
          return;
        }
        if (raw.kind === 'consensus') {
          el.innerHTML =
            `<div style="font-weight:600;color:#e8e9ea">${consensusLabel} ${formatPct(raw.y)} · ${fmtDate(raw.x)}</div>` +
            (consensusMeta ? `<div style="margin-top:2px;color:#b7b8b1">${consensusMeta}</div>` : '') +
            sparklineSvg(raw.history);
        } else if (raw.id) {
          // Gather every market clustered near the hovered point so overlapping
          // dots are all shown, not just the nearest one.
          const chart = ctx.chart;
          const el0 = tt.dataPoints[0].element;
          const near = marketPoints
            .filter((m) => {
              const px = chart.scales.x.getPixelForValue(m.x);
              const py = chart.scales.y.getPixelForValue(m.y);
              return Math.hypot(px - el0.x, py - el0.y) <= 16;
            })
            .sort((a, b) => b.y - a.y);
          const entry = (m: MarketPoint): string => {
            const meta = [m.src, fmtLiq(m.liq, m.liqUnit)].filter(Boolean).join(' · ');
            return (
              `<div style="font-weight:600;color:#e8e9ea">${formatPct(m.y)} — ${fmtDate(m.x)}</div>` +
              `<div style="margin-top:2px;max-width:220px;white-space:normal">${m.q}</div>` +
              (meta ? `<div style="margin-top:2px;color:#b7b8b1">${meta}</div>` : '')
            );
          };
          el.innerHTML =
            near.length <= 1
              ? entry(raw) + sparklineSvg(raw.history)
              : near
                  .map(entry)
                  .join('<div style="height:1px;background:#3a3f45;margin:7px 0"></div>');
        } else {
          el.style.opacity = '0';
          return;
        }
        el.style.opacity = '1';
        el.style.left = `${tt.caretX}px`;
        el.style.top = `${tt.caretY}px`;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config: any = {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'curve',
              data: series.data,
              parsing: false,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              borderColor: (c: any) => {
                const ch = c.chart;
                const area = ch.chartArea;
                if (!area || !ch.scales?.y) return ACCENT;
                const g = ch.ctx.createLinearGradient(
                  0,
                  ch.scales.y.getPixelForValue(0),
                  0,
                  ch.scales.y.getPixelForValue(yMax)
                );
                g.addColorStop(0, probColor(0));
                g.addColorStop(Math.min(1, 0.5 / yMax), probColor(0.5));
                g.addColorStop(1, probColor(yMax));
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
              borderColor: TODAY_LINE,
              borderWidth: 1,
              borderDash: [3, 3],
              pointRadius: 0,
              order: 3,
            },
            {
              label: 'markets',
              data: marketPoints,
              parsing: false,
              showLine: false,
              // The closest/optimistic points are rendered as icons by the
              // overlay plugin, so hide their dot (transparent) but keep a
              // radius for hover; other markets show a liquidity-sized dot.
              pointBorderColor: marketPoints.map((m) =>
                m.id === closestId || m.id === optimisticId
                  ? 'transparent'
                  : probColor(m.y)
              ),
              pointBackgroundColor: 'transparent',
              pointStyle: 'circle',
              pointRadius: marketPoints.map((m) =>
                m.id === closestId || m.id === optimisticId ? 10 : m.r
              ),
              pointHoverRadius: marketPoints.map((m) =>
                m.id === closestId || m.id === optimisticId ? 10 : m.r + 2
              ),
              pointBorderWidth: 1.5,
              order: 1,
            },
            {
              label: 'consensus',
              data: consensusPoint,
              parsing: false,
              showLine: false,
              // Invisible but hoverable; the icon is drawn by the overlay plugin.
              pointRadius: 9,
              pointHoverRadius: 9,
              pointBackgroundColor: 'transparent',
              pointBorderColor: 'transparent',
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
              min: xMin,
              max: xMax,
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
              max: yMax,
              grid: { color: LINE, drawTicks: false },
              border: { color: LINE },
              ticks: {
                color: AXIS_TEXT,
                font: { size: 12, weight: 400 },
                maxTicksLimit: 5,
                callback: (value: number) =>
                  value === 0 ? '' : formatPct(value),
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false, external: externalTooltip },
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const overlayPlugin: any = {
        id: 'overlay',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        afterDatasetsDraw(chart: any) {
          const { ctx, chartArea, scales } = chart;
          const inArea = (px: number, py: number) =>
            px >= chartArea.left &&
            px <= chartArea.right &&
            py >= chartArea.top &&
            py <= chartArea.bottom;

          // Which point is currently hovered (Chart.js active element), so the
          // mark grows on hover like the regular dots do.
          const datasets = chart.data.datasets;
          const marketsIdx = datasets.findIndex((d: any) => d.label === 'markets');
          const consensusIdx = datasets.findIndex((d: any) => d.label === 'consensus');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const active = chart.getActiveElements() as { datasetIndex: number; index: number }[];
          const isActive = (di: number, idx: number) =>
            active.some((a) => a.datasetIndex === di && a.index === idx);

          marketPoints.forEach((m, i) => {
            const px = scales.x.getPixelForValue(m.x);
            const py = scales.y.getPixelForValue(m.y);
            if (!inArea(px, py)) return;
            if (m.id === closestId)
              drawClock(ctx, px, py, probColor(m.y), isActive(marketsIdx, i));
            if (m.id === optimisticId)
              drawStar(ctx, px, py, probColor(m.y), isActive(marketsIdx, i));
          });
          if (consensus) {
            const px = scales.x.getPixelForValue(consensus.x);
            const py = scales.y.getPixelForValue(consensus.y);
            if (inArea(px, py))
              drawAverage(ctx, px, py, probColor(consensus.y), isActive(consensusIdx, 0));
          }
        },
      };
      config.plugins = [overlayPlugin];

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
  }, [series, marketPoints, consensus, closestId, optimisticId, yMax, xMin, xMax]);

  return (
    <div className="w-full">
      <div
        role="img"
        aria-label={strings.chartAria ?? ''}
        className="relative h-[300px] w-full sm:h-[386px]"
      >
        <canvas ref={canvasRef} />
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-md px-2.5 py-2 text-[12px] leading-snug opacity-0 transition-opacity"
          style={{ background: '#22262b', color: '#e8e9ea' }}
        />
      </div>
    </div>
  );
}

export interface HeroChartLoaderProps {
  today: string;
  closestId: string | null;
  optimisticId: string | null;
  /** Consensus centroid: epoch-ms x, 0–1 y. Its history comes from the JSON. */
  consensus: { x: number; y: number } | null;
  strings: Record<string, string>;
  /** Cache-bust version (the page's lastUpdated). */
  version: string | null;
}

// Loader: fetch the prebuilt series (kept out of the page HTML), then render
// the chart. A height-matched placeholder holds the layout while the small
// fetch resolves; on failure the area stays empty rather than throwing.
function HeroChart(props: HeroChartLoaderProps) {
  const [data, setData] = useState<ChartData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchChartData(props.version)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [props.version]);

  if (data) {
    return (
      <HeroChartView
        datasets={data.hero.datasets}
        today={props.today}
        markets={data.hero.markets}
        consensus={
          props.consensus
            ? { ...props.consensus, history: data.consensusHistory }
            : null
        }
        closestId={props.closestId}
        optimisticId={props.optimisticId}
        strings={props.strings}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={props.strings.chartAria ?? ''}
      aria-busy={!failed}
      className="h-[300px] w-full sm:h-[386px]"
    />
  );
}

export default HeroChart;
