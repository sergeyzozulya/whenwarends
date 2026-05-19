// Main timeline — an Astro island (client:visible). Replaces the old forward
// CDF. Plots EVERY metric we actually retain (2022→now) as small pure-SVG
// sparklines sharing one continuous time axis, with a single scrub cursor.
// Moving/clicking the cursor (or arrow keys) picks a date; each metric shows
// its value as-of that date and the brief panel shows the nearest brief at or
// before it.
//
// No charting lib — pure SVG. Server-rendered at the latest date, so no-JS
// users still see current values + the latest brief; hydration only adds the
// scrub interaction. Honest: a sparkline spans only the dates that series
// actually has — no fabricated bridge across gaps.

import { useMemo, useRef, useState } from 'react';
import type { BriefArchiveEntry, HistorySeries } from '@lib/homepage';

const ACCENT = '#2c5aa0';

export interface HistoryTimelineProps {
  /** Dense per-metric series (any order); the component fixes display order. */
  history: HistorySeries[];
  /** Brief archive, any order; used for the panel (nearest brief ≤ date). */
  entries: BriefArchiveEntry[];
  /** Pre-resolved i18n + locale from the .astro page. */
  strings: Record<string, string>;
}

// Secondary-timeline layout, top → bottom. `prob` is absent (war-end
// probability is the prominent hero above). Related metrics that share a
// theme but differ in magnitude are drawn as ONE multi-line graph, each line
// independently scaled to its own range + distinctly coloured:
//   • conflict   — intensity (blue) + fire activity (amber) + tone (purple)
//   • economy    — RUB (red) + UAH (blue)
//   • gdp        — Russia (red) + Ukraine (blue), real % y/y, quarterly
//   • inflation  — Russia (red) + Ukraine (blue), CPI % y/y, monthly
// `draw`: 'line' (default) = scaled polyline; 'heat' = full-height background
// columns, white at the series min → light red at its max (a density band).
type LineSpec = {
  key: string;
  color: string;
  fmt: (v: number) => string;
  draw?: 'line' | 'heat';
};
type LayoutItem =
  | { kind: 'single'; key: string; fmt: (v: number) => string }
  // `sharedScale`: all lines share one y-domain (only meaningful when the
  // lines are the same unit — e.g. % y/y — so the two are visually
  // comparable). Default = each line scaled to its own range.
  | {
      kind: 'combo';
      key: string;
      lines: LineSpec[];
      sharedScale?: boolean;
    };

const LAYOUT: LayoutItem[] = [
  {
    kind: 'combo',
    key: 'conflict',
    lines: [
      // fire drawn first as a white→light-red density band behind the lines
      { key: 'fire', color: '#f0a0a0', fmt: (v) => String(Math.round(v)), draw: 'heat' },
      { key: 'intensity', color: '#FF0000', fmt: (v) => v.toFixed(1) },
      { key: 'tone', color: '#7a5ea8', fmt: (v) => v.toFixed(1) },
    ],
  },
  // aid chart removed for now (data still collected; ground card unaffected)
  {
    kind: 'combo',
    key: 'economy',
    lines: [
      { key: 'rub', color: '#c0392b', fmt: (v) => `${v.toFixed(2)} RUB/USD` },
      { key: 'uah', color: '#0057b7', fmt: (v) => `${v.toFixed(2)} UAH/USD` },
    ],
  },
  {
    kind: 'combo',
    key: 'gdp',
    sharedScale: true,
    lines: [
      { key: 'ruGdp', color: '#c0392b', fmt: (v) => `${v.toFixed(1)}%` },
      { key: 'uaGdp', color: '#0057b7', fmt: (v) => `${v.toFixed(1)}%` },
    ],
  },
  {
    kind: 'combo',
    key: 'inflation',
    sharedScale: true,
    lines: [
      { key: 'ruCpi', color: '#c0392b', fmt: (v) => `${v.toFixed(1)}%` },
      { key: 'uaCpi', color: '#0057b7', fmt: (v) => `${v.toFixed(1)}%` },
    ],
  },
];

/** Latest point with t ≤ at; points are sorted ascending by t. */
function valueAsOf(
  points: { t: number; v: number }[],
  at: number
): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= at) {
      ans = points[mid].v;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

type Pt = { t: number; v: number };
type Row =
  | {
      kind: 'single';
      key: string;
      label: string;
      points: Pt[];
      fmt: (v: number) => string;
    }
  | {
      kind: 'combo';
      key: string;
      label: string;
      sharedScale?: boolean;
      lines: {
        label: string;
        color: string;
        points: Pt[];
        fmt: (v: number) => string;
        draw?: 'line' | 'heat';
      }[];
    };

function HistoryTimeline({ history, entries, strings }: HistoryTimelineProps) {
  const series = useMemo<Row[]>(() => {
    const pointsOf = (k: string): Pt[] =>
      history.find((h) => h.key === k)?.points ?? [];

    const rows: Row[] = [];
    for (const item of LAYOUT) {
      if (item.kind === 'single') {
        const pts = pointsOf(item.key);
        if (pts.length > 0) {
          rows.push({
            kind: 'single',
            key: item.key,
            label: strings[item.key] ?? item.key,
            fmt: item.fmt,
            points: pts,
          });
        }
      } else {
        const lines = item.lines
          .map((e) => ({
            label: strings[e.key] ?? e.key,
            color: e.color,
            fmt: e.fmt,
            draw: e.draw,
            points: pointsOf(e.key),
          }))
          .filter((l) => l.points.length > 0);
        if (lines.length > 0) {
          rows.push({
            kind: 'combo',
            key: item.key,
            label: strings[item.key] ?? item.key,
            sharedScale: item.sharedScale,
            lines,
          });
        }
      }
    }
    return rows;
  }, [history, strings]);

  const briefs = useMemo(
    () =>
      [...entries]
        .filter((e) => e.text.trim() !== '')
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => ({ ...e, t: Date.parse(`${e.date}T00:00:00Z`) })),
    [entries]
  );

  // Secondary timelines start at the full-scale invasion (some series, e.g.
  // World Bank macro, run back to the 1990s — irrelevant pre-war history that
  // would crush the in-war signal). End at the latest data we actually have.
  const WAR_START = Date.parse('2022-02-24T00:00:00Z');
  const [t0, t1] = useMemo(() => {
    const ts: number[] = [];
    for (const s of series) {
      const ptsArrs =
        s.kind === 'combo' ? s.lines.map((l) => l.points) : [s.points];
      for (const p of ptsArrs) if (p.length) ts.push(p[p.length - 1].t);
    }
    for (const b of briefs) ts.push(b.t);
    const hi = ts.length ? Math.max(...ts) : WAR_START + 1;
    return [WAR_START, hi <= WAR_START ? WAR_START + 1 : hi];
  }, [series, briefs]);

  const [frac, setFrac] = useState(1); // default = latest (no-JS shows now)
  const trackRef = useRef<HTMLDivElement | null>(null);

  const locale = strings.locale || 'en-US';
  const fmtDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    [locale]
  );

  if (series.length === 0 && briefs.length === 0) {
    return (
      <p className="text-sm font-normal text-gray-500">{strings.noBrief}</p>
    );
  }

  const selT = t0 + frac * (t1 - t0);
  const selectedDate = fmtDate.format(new Date(selT));

  function fracFromClientX(clientX: number): number {
    const el = trackRef.current;
    if (!el) return frac;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return frac;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function onKey(e: React.KeyboardEvent) {
    let f = frac;
    if (e.key === 'ArrowLeft') f = Math.max(0, frac - 0.02);
    else if (e.key === 'ArrowRight') f = Math.min(1, frac + 0.02);
    else if (e.key === 'Home') f = 0;
    else if (e.key === 'End') f = 1;
    else return;
    e.preventDefault();
    setFrac(f);
  }

  // Brief at or before the selected date (else the earliest, so the panel is
  // never blank once any brief exists).
  const curBrief =
    [...briefs].reverse().find((b) => b.t <= selT) ?? briefs[0] ?? null;

  const W = 600;
  const H = 34;
  const pad = 3;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;
  const xOf = (t: number) => pad + ((t - t0) / (t1 - t0)) * innerW;
  const cursorX = pad + frac * innerW;

  function spark(
    points: { t: number; v: number }[],
    // Explicit y-domain for shared-scale combos; omitted = scale to own range.
    domain?: [number, number]
  ): {
    line: string;
    dotY: number | null;
  } {
    // Only the in-window slice scales and draws — pre-war points (e.g. 1993
    // hyperinflation) must not crush the in-war signal or spill off-canvas.
    const win = points.filter((p) => p.t >= t0 && p.t <= t1);
    if (win.length === 0) return { line: '', dotY: null };
    const vs = win.map((p) => p.v);
    const min = domain ? domain[0] : Math.min(...vs);
    const max = domain ? domain[1] : Math.max(...vs);
    const span = max - min;
    const yOf = (v: number) =>
      pad + innerH - (span === 0 ? 0.5 : (v - min) / span) * innerH;
    // STEP line: a value holds until the next observation (no straight-line
    // interpolation between sparse points — that would invent figures the
    // source never published). This keeps the dot and the legend, which both
    // read the last-known value as-of the cursor, exactly ON the line.
    const seg: string[] = [];
    for (let i = 0; i < win.length; i++) {
      const x = xOf(win[i].t);
      if (i > 0) {
        // horizontal carry at the previous value to this point's x
        seg.push(`${x.toFixed(1)},${yOf(win[i - 1].v).toFixed(1)}`);
      }
      seg.push(`${x.toFixed(1)},${yOf(win[i].v).toFixed(1)}`);
    }
    // carry the last-known value flat to the right edge (it's still the
    // current reading until a newer observation arrives).
    seg.push(
      `${(pad + innerW).toFixed(1)},${yOf(win[win.length - 1].v).toFixed(1)}`
    );
    const line = seg.join(' ');
    const cv = valueAsOf(win, selT);
    return { line, dotY: cv === null ? null : yOf(cv) };
  }

  // Shared chart chrome for every minor chart: a tiny border, vertical-axis
  // tick marks on BOTH edges (top & bottom = the value range), and an
  // optional dashed zero baseline (passed only for the % y/y combos).
  function chartFrame(zeroY: number | null) {
    return (
      <>
        {zeroY !== null && (
          <line
            x1={pad}
            y1={zeroY}
            x2={W - pad}
            y2={zeroY}
            stroke="#9ca3af"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <rect
          x={pad}
          y={pad}
          width={innerW}
          height={innerH}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {[pad, H - pad].map((y) => (
          <g key={y}>
            <line x1={pad} y1={y} x2={pad + 8} y2={y} stroke="#cbd5e1" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={W - pad} y1={y} x2={W - pad - 8} y2={y} stroke="#cbd5e1" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </>
    );
  }

  return (
    <section
      aria-labelledby="history-heading"
      className="space-y-4"
    >
      <h2
        id="history-heading"
        className="text-[18px] font-medium text-gray-900"
      >
        {strings.heading}
      </h2>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={strings.scrubAria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-valuetext={selectedDate}
        onKeyDown={onKey}
        onClick={(e) => setFrac(fracFromClientX(e.clientX))}
        onPointerMove={(e) => {
          if (e.buttons === 1 || e.pointerType === 'mouse')
            setFrac(fracFromClientX(e.clientX));
        }}
        className="cursor-ew-resize select-none rounded outline-none focus-visible:ring-2 focus-visible:ring-[#2c5aa0]"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-gray-900">
            {selectedDate}
          </span>
          {curBrief && (
            <span className="text-xs font-normal text-gray-500">
              {curBrief.reconstructed
                ? strings.reconstructed
                : strings.aiLabel}
            </span>
          )}
        </div>

        <div className="mt-3 space-y-4">
          {series.map((s) => {
            if (s.kind === 'combo') {
              const drawn = s.lines.filter((ln) => ln.draw !== 'heat');
              // Shared y-domain across the drawn lines (same unit) so the two
              // are directly comparable; otherwise each scales to its own.
              let dom: [number, number] | undefined;
              if (s.sharedScale) {
                const vs = drawn.flatMap((ln) =>
                  ln.points
                    .filter((p) => p.t >= t0 && p.t <= t1)
                    .map((p) => p.v)
                );
                if (vs.length > 0) {
                  const lo = Math.min(...vs);
                  const hi = Math.max(...vs);
                  if (hi > lo) dom = [lo, hi];
                }
              }
              // Zero baseline only when the shared domain straddles 0
              // (the % y/y combos: GDP & inflation).
              let zeroY: number | null = null;
              if (dom && dom[0] <= 0 && dom[1] >= 0) {
                zeroY =
                  pad + innerH - ((0 - dom[0]) / (dom[1] - dom[0])) * innerH;
              }
              return (
                <div key={s.key}>
                  <div className="flex items-baseline justify-between gap-x-4">
                    <span className="text-xs font-normal text-gray-500">
                      {s.label}
                    </span>
                    <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1">
                      {s.lines.map((ln) => {
                        const v = valueAsOf(ln.points, selT);
                        return (
                          <span
                            key={ln.label}
                            className="text-xs font-medium"
                            style={{ color: ln.color }}
                          >
                            {ln.label}: {v === null ? '—' : ln.fmt(v)}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <svg
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    className="mt-1 block h-[4.5rem] w-full"
                    aria-hidden="true"
                  >
                    {/* heat lines first: white→light-red full-height columns */}
                    {s.lines
                      .filter((ln) => ln.draw === 'heat')
                      .map((ln) => {
                        const win = ln.points.filter(
                          (p) => p.t >= t0 && p.t <= t1
                        );
                        if (win.length === 0) return null;
                        const vs = win.map((p) => p.v);
                        const min = Math.min(...vs);
                        const max = Math.max(...vs);
                        const span = max - min;
                        const barW = Math.max(
                          1.2,
                          innerW / Math.max(1, win.length)
                        );
                        return (
                          <g key={ln.label}>
                            {win.map((p, i) => {
                              const tN =
                                span === 0 ? 0 : (p.v - min) / span;
                              // white (255,255,255) → light red (240,120,120)
                              const g = Math.round(255 - 135 * tN);
                              return (
                                <line
                                  key={i}
                                  x1={xOf(p.t)}
                                  y1={0}
                                  x2={xOf(p.t)}
                                  y2={H}
                                  stroke={`rgb(255,${g},${g})`}
                                  strokeWidth={barW}
                                />
                              );
                            })}
                          </g>
                        );
                      })}
                    {chartFrame(zeroY)}
                    {drawn.map((ln) => {
                      const { line, dotY } = spark(ln.points, dom);
                      return (
                        <g key={ln.label}>
                          <polyline
                            points={line}
                            fill="none"
                            stroke={ln.color}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                          {dotY !== null && (
                            // zero-length line + round cap + non-scaling
                            // stroke = a true round dot, immune to the
                            // non-uniform viewBox scaling.
                            <line
                              x1={cursorX}
                              y1={dotY}
                              x2={cursorX}
                              y2={dotY}
                              stroke={ln.color}
                              strokeWidth={7}
                              strokeLinecap="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          )}
                        </g>
                      );
                    })}
                    <line
                      x1={cursorX}
                      y1={0}
                      x2={cursorX}
                      y2={H}
                      stroke={ACCENT}
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                </div>
              );
            }
            const { line, dotY } = spark(s.points);
            const cv = valueAsOf(s.points, selT);
            return (
              <div key={s.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-normal text-gray-500">
                    {s.label}
                  </span>
                  <span className="text-xs font-medium text-gray-800">
                    {cv === null ? '—' : s.fmt(cv)}
                  </span>
                </div>
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  preserveAspectRatio="none"
                  className="mt-1 block h-[4.5rem] w-full"
                  aria-hidden="true"
                >
                  {chartFrame(null)}
                  <polyline
                    points={line}
                    fill="none"
                    stroke="#9ca3af"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={cursorX}
                    y1={0}
                    x2={cursorX}
                    y2={H}
                    stroke={ACCENT}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  {dotY !== null && (
                    <line
                      x1={cursorX}
                      y1={dotY}
                      x2={cursorX}
                      y2={dotY}
                      stroke={ACCENT}
                      strokeWidth={7}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </svg>
              </div>
            );
          })}
        </div>
      </div>

    </section>
  );
}

export default HistoryTimeline;
