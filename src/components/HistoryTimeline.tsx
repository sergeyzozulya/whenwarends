// "The war in data" — an Astro island (client:visible).
//
// A scrub handle picks a date from the full-scale invasion to the latest
// data; every indicator reads its value as of that date, its 12-month
// delta, and a small step sparkline. Pure SVG, no chart lib. Honest: a
// value holds until the next real observation (step line); a missing
// month/quarter is skipped, never interpolated.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistorySeries } from '@lib/homepage';

const ACCENT = '#3b6b97';
const SLIDER = '#255b7d';
const TRACK = '#dee2e5';
const UP = '#4f7a52';
const DOWN = '#b5524e';
const WAR_START = Date.UTC(2022, 1, 24);
const YEAR = 365 * 24 * 3600 * 1000;
const PLAY_MS = 9000;

export interface HistoryTimelineProps {
  history: HistorySeries[];
  strings: Record<string, string>;
}

type Fmt = (v: number) => string;
type Ind = { key: string; source: string; unit: string; val: Fmt; dlt: Fmt };

const signed1 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
const eurC = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 1,
});

const INDICATORS: Ind[] = [
  { key: 'intensity', source: 'GDELT', unit: 'index', val: (v) => v.toFixed(1), dlt: (d) => d.toFixed(1) },
  { key: 'tone', source: 'GDELT', unit: '', val: (v) => v.toFixed(2), dlt: (d) => d.toFixed(2) },
  { key: 'fire', source: 'NASA FIRMS', unit: '/day', val: (v) => String(Math.round(v)), dlt: (d) => String(Math.round(d)) },
  {
    key: 'aid',
    source: 'Kiel',
    unit: 'allocated',
    val: (v) => eurC.format(v),
    dlt: (d) => eurC.format(d),
  },
  {
    key: 'uaLoss',
    source: 'Oryx',
    unit: 'confirmed',
    val: (v) => Math.round(v).toLocaleString('en-US'),
    dlt: (d) => Math.round(d).toLocaleString('en-US'),
  },
  {
    key: 'ruLoss',
    source: 'Oryx',
    unit: 'confirmed',
    val: (v) => Math.round(v).toLocaleString('en-US'),
    dlt: (d) => Math.round(d).toLocaleString('en-US'),
  },
  { key: 'uah', source: 'NBU', unit: 'UAH/USD', val: (v) => v.toFixed(2), dlt: (d) => d.toFixed(2) },
  { key: 'rub', source: 'CBR', unit: 'RUB/USD', val: (v) => v.toFixed(1), dlt: (d) => d.toFixed(1) },
  { key: 'uaGdp', source: 'World Bank', unit: '% y/y', val: signed1, dlt: signed1 },
  { key: 'ruGdp', source: 'World Bank', unit: '% y/y', val: signed1, dlt: signed1 },
  { key: 'uaCpi', source: 'NBU', unit: '% y/y', val: signed1, dlt: signed1 },
  { key: 'ruCpi', source: 'World Bank', unit: '% y/y', val: signed1, dlt: signed1 },
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

function HistoryTimeline({ history, strings }: HistoryTimelineProps) {
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

  const cards = INDICATORS.map((ind) => ({
    ind,
    pts: byKey.get(ind.key) ?? [],
  })).filter((c) => c.pts.length > 0);

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
    'cursor-pointer rounded-[2px] border border-[#dee2e5] px-2.5 py-1.5 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#3b6b97]';

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{strings.asOf ?? 'Showing data as of'}</p>
          <p className="mt-1 text-[28px] font-normal leading-none text-[var(--color-ink)]">
            {monthLabel(selT)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={ctrlCls}
            onClick={() => {
              setPlaying(false);
              setFrac(0);
            }}
          >
            {monthLabel(WAR_START)}
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

      <div className="mt-9 grid grid-cols-1 border-l border-t border-[var(--color-line)] sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {cards.map(({ ind, pts }) => {
          const cur = asOf(pts, selT);
          const prev = asOf(pts, selT - YEAR);
          const delta = cur !== null && prev !== null ? cur - prev : null;
          const win = pts.filter((p) => p.t >= WAR_START && p.t <= selT);

          let line = '';
          let dotY: number | null = null;
          if (win.length > 0) {
            const vs = win.map((p) => p.v);
            const lo = Math.min(...vs);
            const hi = Math.max(...vs);
            const span = hi - lo;
            const xOf = (t: number) =>
              pad +
              ((t - WAR_START) / Math.max(1, selT - WAR_START)) *
                (W - pad * 2);
            const yOf = (v: number) =>
              pad +
              (H - pad * 2) -
              (span === 0 ? 0.5 : (v - lo) / span) * (H - pad * 2);
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
            line = seg.join(' ');
            if (cur !== null) dotY = yOf(cur);
          }

          const up = delta !== null && delta >= 0;
          return (
            <div
              key={ind.key}
              className="border-b border-r border-[var(--color-line)] p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] leading-snug text-[var(--color-ink)]">
                  {strings[ind.key] ?? ind.key}
                </span>
                <span className="eyebrow shrink-0">{ind.source}</span>
              </div>
              <p className="mt-3 text-[22px] font-normal leading-none tracking-[-0.01em] text-[var(--color-ink)]">
                {cur === null ? '—' : ind.val(cur)}
                {cur !== null && ind.unit && (
                  <span className="ml-1 text-[11px] text-[var(--color-faint)]">
                    {ind.unit}
                  </span>
                )}
              </p>
              <p className="mt-2 h-4 text-[11px]">
                {delta === null ? (
                  <span className="text-[var(--color-faint)]">—</span>
                ) : (
                  <span style={{ color: up ? UP : DOWN }}>
                    {up ? '▲' : '▼'} {ind.dlt(Math.abs(delta))}
                    <span className="text-[var(--color-faint)]">
                      {' '}
                      · {strings.per12m ?? '12m'}
                    </span>
                  </span>
                )}
              </p>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="mt-3 block h-9 w-full"
                aria-hidden="true"
              >
                <polyline
                  points={line}
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {dotY !== null && (
                  <line
                    x1={W - pad}
                    y1={dotY}
                    x2={W - pad}
                    y2={dotY}
                    stroke={ACCENT}
                    strokeWidth={6}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
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

export default HistoryTimeline;
