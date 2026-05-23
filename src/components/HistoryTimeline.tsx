// "The war in data" — an Astro island (client:visible).
//
// A scrub handle picks a date from the full-scale invasion to the latest
// data; every indicator reads its value as of that date, its 12-month
// delta, and a small step sparkline. Pure SVG, no chart lib. Honest: a
// value holds until the next real observation (step line); a missing
// month/quarter is skipped, never interpolated.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistorySeries } from '@lib/homepage';
import { fetchChartData } from '../lib/chartData';
import ChartSkeleton from './ChartSkeleton';

const ACCENT = '#3b6b97';
const SLIDER = '#255b7d';
const TRACK = '#dee2e5';
const UP = '#4f7a52';
const DOWN = '#b5524e';
// Merged dual-series cards: Ukraine = the accent blue, Russia = the muted
// brick (reusing DOWN's tone) — staying within the one-accent palette rather
// than introducing loud primaries.
const UA_COLOR = ACCENT;
const RU_COLOR = '#b5524e';
// Grayscale second line for same-nation pairs (refugees vs IDPs) — within the
// "one accent + grayscale" palette, so it never reads as a third "side".
const NEUTRAL = '#8a929a';
const WAR_START = Date.UTC(2022, 1, 24);
const YEAR = 365 * 24 * 3600 * 1000;
const PLAY_MS = 9000;

export interface HistoryTimelineProps {
  history: HistorySeries[];
  strings: Record<string, string>;
}

type Fmt = (v: number) => string;

/** One plotted line in a card. `legend` is a strings key for the side label
 *  (ru/ua) on merged cards; empty string for single-series cards. */
type Series = { key: string; color: string; legend: string };

/** A timeline card: one series (big number) or two merged (Ukraine vs Russia,
 *  sharing a y-scale so their levels stay comparable). */
type Card = {
  label: string; // strings key for the card title
  source: string; // attribution (proper names, not translated)
  unit: string;
  val: Fmt;
  dlt: Fmt;
  series: Series[];
  /** Cumulative series shown as monthly FLOW (per-month change) instead of the
   *  ever-rising total — far more informative as a sparkline. */
  monthly?: boolean;
};

const signed1 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
const intC = (v: number) => Math.round(v).toLocaleString('en-US');
const compactN = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const eurC = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 1,
});

const single = (key: string, color = ACCENT): Series[] => [
  { key, color, legend: '' },
];
const uaRu = (uaKey: string, ruKey: string): Series[] => [
  { key: uaKey, color: UA_COLOR, legend: 'ua' },
  { key: ruKey, color: RU_COLOR, legend: 'ru' },
];

const CARDS: Card[] = [
  // Battlefield + humanitarian.
  { label: 'front', source: 'DeepState', unit: 'km²', val: intC, dlt: intC, series: single('front', RU_COLOR) },
  { label: 'intensity', source: 'GDELT', unit: 'index', val: (v) => v.toFixed(1), dlt: (d) => d.toFixed(1), series: single('intensity') },
  { label: 'tone', source: 'GDELT', unit: '', val: (v) => v.toFixed(2), dlt: (d) => d.toFixed(2), series: single('tone') },
  { label: 'fire', source: 'NASA FIRMS', unit: '/day', val: intC, dlt: intC, series: single('fire') },
  { label: 'aid', source: 'Kiel', unit: '/mo', val: (v) => eurC.format(v), dlt: (d) => eurC.format(d), series: single('aid'), monthly: true },
  // Displacement: refugees abroad (accent) vs IDPs inside Ukraine (grayscale).
  {
    label: 'displaced',
    source: 'UNHCR',
    unit: 'people',
    val: (v) => compactN.format(v),
    dlt: (d) => compactN.format(d),
    series: [
      { key: 'refugees', color: UA_COLOR, legend: 'refAbroad' },
      { key: 'idps', color: NEUTRAL, legend: 'refIdp' },
    ],
  },
  { label: 'loss', source: 'Oryx', unit: 'confirmed', val: intC, dlt: intC, series: uaRu('uaLoss', 'ruLoss') },
  // Financing.
  { label: 'oil', source: 'EIA', unit: 'USD/bbl', val: (v) => v.toFixed(1), dlt: (d) => d.toFixed(1), series: single('oil') },
  // Macro (merged Ukraine + Russia pairs).
  { label: 'fx', source: 'NBU · CBR', unit: 'per USD', val: (v) => v.toFixed(1), dlt: (d) => d.toFixed(1), series: uaRu('uah', 'rub') },
  { label: 'gdp', source: 'World Bank', unit: '% y/y', val: signed1, dlt: signed1, series: uaRu('uaGdp', 'ruGdp') },
  { label: 'cpi', source: 'NBU · World Bank', unit: '% y/y', val: signed1, dlt: signed1, series: uaRu('uaCpi', 'ruCpi') },
  { label: 'revenue', source: 'CREA', unit: '/mo', val: (v) => eurC.format(v), dlt: (d) => eurC.format(d), series: single('revenue', RU_COLOR), monthly: true },
];

/** Latest value with t ≤ at (points sorted ascending). */
function asOf(points: { t: number; v: number }[], at: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= at) {
      ans = points[mid].v;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Turn a cumulative series into a monthly-FLOW series: the per-month change in
 * the running total. Each month keeps its last cumulative value; the flow for a
 * month is that value minus the prior month's, labelled at the month's start.
 * The first month is dropped (no prior to difference). Honest — every flow is a
 * difference of two real observations.
 */
function toMonthlyFlow(
  points: { t: number; v: number }[]
): { t: number; v: number }[] {
  if (points.length === 0) return [];
  const monthEnd = new Map<string, { t: number; v: number }>();
  for (const p of points) {
    const d = new Date(p.t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const cur = monthEnd.get(key);
    if (!cur || p.t > cur.t) monthEnd.set(key, p);
  }
  const months = [...monthEnd.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: { t: number; v: number }[] = [];
  for (let i = 1; i < months.length; i++) {
    const [key, end] = months[i];
    const [y, m] = key.split('-').map(Number);
    out.push({ t: Date.UTC(y, m - 1, 1), v: end.v - months[i - 1][1].v });
  }
  return out;
}

function HistoryTimelineView({ history, strings }: HistoryTimelineProps) {
  const byKey = useMemo(() => {
    const m = new Map<string, { t: number; v: number }[]>();
    for (const h of history)
      m.set(h.key, [...h.points].sort((a, b) => a.t - b.t));
    return m;
  }, [history]);

  const tMax = useMemo(() => {
    let mx = WAR_START + 1;
    for (const pts of byKey.values()) {
      const last = pts[pts.length - 1];
      if (last && last.t > mx) mx = last.t;
    }
    return mx;
  }, [byKey]);

  const [frac, setFrac] = useState(1);
  const [playing, setPlaying] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const selT = WAR_START + frac * (tMax - WAR_START);

  // Play: sweep frac → 1, then stop. rAF so it's smooth and pauses cleanly.
  useEffect(() => {
    if (!playing) return;
    if (frac >= 1) {
      setPlaying(false);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setFrac((f) => {
        const nf = f + dt / PLAY_MS;
        if (nf >= 1) return 1;
        return nf;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frac]);

  const locale = strings.locale || 'en-US';
  const fmtMonth = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }),
    [locale]
  );
  // Intl returns lowercase month names for uk/ru ("лютий 2022 р.") — the
  // design wants them capitalized ("Лютий 2022 р.").
  const monthLabel = (ms: number) => {
    const s = fmtMonth.format(new Date(ms));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const years: number[] = [];
  for (let y = 2022; y <= new Date(tMax).getUTCFullYear(); y++) years.push(y);

  // Resolve each card's lines to the series we actually hold; drop a line with
  // no data and a card with no lines.
  const cards = CARDS.map((card) => ({
    card,
    lines: card.series
      .map((s) => {
        const raw = byKey.get(s.key) ?? [];
        return { s, pts: card.monthly ? toMonthlyFlow(raw) : raw };
      })
      .filter((l) => l.pts.length > 0),
  })).filter((c) => c.lines.length > 0);

  if (cards.length === 0)
    return <p className="text-[13px] text-[var(--color-faint)]">—</p>;

  const fracFromX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return frac;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return frac;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const onKey = (e: React.KeyboardEvent) => {
    let f = frac;
    if (e.key === 'ArrowLeft') f = Math.max(0, frac - 0.02);
    else if (e.key === 'ArrowRight') f = Math.min(1, frac + 0.02);
    else if (e.key === 'Home') f = 0;
    else if (e.key === 'End') f = 1;
    else return;
    e.preventDefault();
    setPlaying(false);
    setFrac(f);
  };

  const W = 240;
  const H = 44;
  const pad = 2;

  const ctrlCls =
    'flex items-center justify-center text-center cursor-pointer rounded-[2px] border border-[#dee2e5] px-2.5 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#3b6b97]';

  return (
    <div>
      {/* Date readout + controls + scrubber stay pinned (below the masthead)
          while the cards scroll. -mx-8 spans the card's p-8 padding; the white
          surface hides cards passing underneath. */}
      <div className="sticky top-14 z-30 -mx-8 bg-[var(--color-surface)] px-8 pb-2 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{strings.asOf ?? 'Showing data as of'}</p>
          <p className="mt-1 text-[28px] font-normal leading-none text-[var(--color-ink)]">
            {monthLabel(selT)}
          </p>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:items-center">
          <button
            type="button"
            className={ctrlCls}
            onClick={() => {
              setPlaying(false);
              setFrac(0);
            }}
          >
            {strings.start ?? 'Start'}
          </button>
          <button
            type="button"
            className={ctrlCls}
            aria-pressed={playing}
            onClick={() =>
              setPlaying((p) => {
                if (!p && frac >= 1) setFrac(0);
                return !p;
              })
            }
          >
            {playing ? (strings.pause ?? 'Pause') : (strings.play ?? 'Play')}
          </button>
          <button
            type="button"
            className={ctrlCls}
            onClick={() => {
              setPlaying(false);
              setFrac(1);
            }}
          >
            {strings.now ?? 'Now'}
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={strings.scrubAria ?? 'Scrub the timeline to a date'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-valuetext={monthLabel(selT)}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setPlaying(false);
          setFrac(fracFromX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) setFrac(fracFromX(e.clientX));
        }}
        className="relative mt-7 h-5 cursor-ew-resize select-none outline-none"
      >
        <div
          className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px]"
          style={{ background: TRACK }}
        />
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[2px]"
          style={{ background: SLIDER, width: `${frac * 100}%` }}
        />
        <div
          className="absolute top-1/2 h-[14px] w-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
          style={{ left: `${frac * 100}%`, border: `2px solid ${SLIDER}` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-[var(--color-faint)]">
        {years.map((y) => (
          <span key={y}>{y}</span>
        ))}
      </div>
      </div>

      <div className="mt-9 grid grid-cols-1 border-l border-t border-[var(--color-line)] sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {cards.map(({ card, lines }) => {
          // Per-line value as-of the cursor, 12-month delta, and windowed pts.
          const lineData = lines.map(({ s, pts }) => {
            const cur = asOf(pts, selT);
            const prev = asOf(pts, selT - YEAR);
            const delta = cur !== null && prev !== null ? cur - prev : null;
            const win = pts.filter((p) => p.t >= WAR_START && p.t <= selT);
            return { s, cur, delta, win };
          });

          // Shared y-scale across the card's lines so RU vs UA levels stay
          // comparable; the sparkline shows shape, the legend the exact number.
          const allV = lineData.flatMap((l) => l.win.map((p) => p.v));
          const lo = allV.length ? Math.min(...allV) : 0;
          const hi = allV.length ? Math.max(...allV) : 1;
          const span = hi - lo;
          const xOf = (t: number) =>
            pad +
            ((t - WAR_START) / Math.max(1, selT - WAR_START)) * (W - pad * 2);
          const yOf = (v: number) =>
            pad +
            (H - pad * 2) -
            (span === 0 ? 0.5 : (v - lo) / span) * (H - pad * 2);
          const polyOf = (win: { t: number; v: number }[]) => {
            const seg: string[] = [];
            for (let i = 0; i < win.length; i++) {
              const x = xOf(win[i].t);
              if (i > 0)
                seg.push(`${x.toFixed(1)},${yOf(win[i - 1].v).toFixed(1)}`);
              seg.push(`${x.toFixed(1)},${yOf(win[i].v).toFixed(1)}`);
            }
            seg.push(
              `${(W - pad).toFixed(1)},${yOf(win[win.length - 1].v).toFixed(1)}`
            );
            return seg.join(' ');
          };

          const merged = card.series.length > 1;
          return (
            <div
              key={card.label}
              className="border-b border-r border-[var(--color-line)] p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] leading-snug text-[var(--color-ink)]">
                  {strings[card.label] ?? card.label}
                </span>
                <span className="eyebrow shrink-0">{card.source}</span>
              </div>

              {merged ? (
                <div className="mt-3 space-y-1.5">
                  {lineData.map(({ s, cur, delta }) => {
                    const up = delta !== null && delta >= 0;
                    return (
                      <div key={s.key} className="flex items-baseline gap-1.5">
                        <span
                          className="inline-block h-2 w-2 shrink-0 translate-y-[1px] rounded-full"
                          style={{ background: s.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-[3rem] shrink-0 text-[11px] text-[var(--color-faint)]">
                          {strings[s.legend] ?? s.legend}
                        </span>
                        <span className="text-[16px] font-normal leading-none text-[var(--color-ink)]">
                          {cur === null ? '—' : card.val(cur)}
                        </span>
                        {delta !== null && (
                          <span
                            className="text-[11px]"
                            style={{ color: up ? UP : DOWN }}
                          >
                            {up ? '▲' : '▼'} {card.dlt(Math.abs(delta))}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <>
                  <p className="mt-3 text-[22px] font-normal leading-none tracking-[-0.01em] text-[var(--color-ink)]">
                    {lineData[0].cur === null
                      ? '—'
                      : card.val(lineData[0].cur)}
                    {lineData[0].cur !== null && card.unit && (
                      <span className="ml-1 text-[11px] text-[var(--color-faint)]">
                        {card.unit}
                      </span>
                    )}
                  </p>
                  <p className="mt-2 h-4 text-[11px]">
                    {lineData[0].delta === null ? (
                      <span className="text-[var(--color-faint)]">—</span>
                    ) : (
                      <span
                        style={{
                          color: lineData[0].delta >= 0 ? UP : DOWN,
                        }}
                      >
                        {lineData[0].delta >= 0 ? '▲' : '▼'}{' '}
                        {card.dlt(Math.abs(lineData[0].delta))}
                        <span className="text-[var(--color-faint)]">
                          {' '}
                          · {strings.per12m ?? '12m'}
                        </span>
                      </span>
                    )}
                  </p>
                </>
              )}

              <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="mt-3 block h-9 w-full"
                aria-hidden="true"
              >
                {lineData.map(({ s, cur, win }) =>
                  // Need ≥2 points for a real line; a single point (e.g. at the
                  // far-left scrub, where only the war-start observation is in
                  // range) would otherwise stretch into a misleading flat line.
                  win.length < 2 ? null : (
                    <g key={s.key}>
                      <polyline
                        points={polyOf(win)}
                        fill="none"
                        stroke={s.color}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      {cur !== null && (
                        <line
                          x1={W - pad}
                          y1={yOf(cur)}
                          x2={W - pad}
                          y2={yOf(cur)}
                          stroke={s.color}
                          strokeWidth={6}
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </g>
                  )
                )}
              </svg>
            </div>
          );
        })}
      </div>

      {strings.lossNote && (
        <p className="mt-6 text-[12px] leading-[1.55] text-[var(--color-faint)]">
          {strings.lossNote}
        </p>
      )}
    </div>
  );
}

export interface HistoryTimelineLoaderProps {
  strings: Record<string, string>;
  /** Cache-bust version (the page's lastUpdated). */
  version: string | null;
}

// Loader: fetch the prebuilt history series (kept out of the page HTML), then
// render the timeline. client:visible, so this only fetches once scrolled into
// view. A height-matched placeholder holds the layout while it loads; on
// failure it renders the view's own empty state.
function HistoryTimeline({ strings, version }: HistoryTimelineLoaderProps) {
  const [history, setHistory] = useState<HistorySeries[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false); // view painted → start the reveal
  const [revealed, setRevealed] = useState(false); // fade done → drop skeleton

  useEffect(() => {
    let cancelled = false;
    fetchChartData(version)
      .then((d) => !cancelled && setHistory(d.history))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [version]);

  // The view renders synchronously (pure SVG), so once history is set it has
  // painted by the next commit — safe to crossfade the skeleton out then.
  useEffect(() => {
    if (history !== null) setReady(true);
  }, [history]);

  if (failed)
    return (
      <div className="flex h-64 w-full items-center justify-center">
        <span className="text-[13px] text-[var(--color-faint)]">
          {strings.unavailable ?? ''}
        </span>
      </div>
    );

  return (
    <div className="relative min-h-64 w-full">
      {history !== null && (
        <HistoryTimelineView history={history} strings={strings} />
      )}
      {!revealed && (
        <div
          aria-hidden={ready}
          onTransitionEnd={() => ready && setRevealed(true)}
          className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] transition-opacity duration-500 ${
            ready ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <ChartSkeleton label={strings.loading} />
        </div>
      )}
    </div>
  );
}

export default HistoryTimeline;
