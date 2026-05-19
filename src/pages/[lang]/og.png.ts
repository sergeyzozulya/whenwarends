// Build-time social-share image (Open Graph / Twitter). One PNG per locale,
// regenerated on every build — so it always reflects the latest data. Shows
// the headline + the two summary cards (closest / most optimistic) with
// real numbers. satori (layout → SVG) + resvg (SVG → PNG); fonts come from
// @fontsource/inter .woff (satori supports woff, not woff2).

import type { APIRoute } from 'astro';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { loadHomePayload } from '@lib/homepage';
import { isoToMs, probColor, type HeroMarket } from '@lib/heroChartData';
import { getTranslation } from '@i18n/index';
import type { Lang } from '@lib/types';

export function getStaticPaths() {
  return [
    { params: { lang: 'uk' } },
    { params: { lang: 'en' } },
    { params: { lang: 'ru' } },
  ];
}

const FONT_DIR = `${process.cwd()}/node_modules/@fontsource/inter/files`;
const font = (name: string) => readFileSync(`${FONT_DIR}/${name}`);
// satori dedupes fonts by (name, weight, style); the Cyrillic faces must
// use a distinct family name or they're dropped and uk/ru render as tofu.
// fontFamily stays 'Inter'; satori falls back to 'InterCy' per-glyph.
const FONTS = [
  { name: 'Inter', weight: 400 as const, style: 'normal' as const, data: font('inter-latin-400-normal.woff') },
  { name: 'Inter', weight: 600 as const, style: 'normal' as const, data: font('inter-latin-600-normal.woff') },
  { name: 'InterCy', weight: 400 as const, style: 'normal' as const, data: font('inter-cyrillic-400-normal.woff') },
  { name: 'InterCy', weight: 600 as const, style: 'normal' as const, data: font('inter-cyrillic-600-normal.woff') },
  { name: 'InterCyE', weight: 400 as const, style: 'normal' as const, data: font('inter-cyrillic-ext-400-normal.woff') },
  { name: 'InterCyE', weight: 600 as const, style: 'normal' as const, data: font('inter-cyrillic-ext-600-normal.woff') },
];

const LOCALE: Record<Lang, string> = { uk: 'uk-UA', en: 'en-US', ru: 'ru-RU' };

// Minimal element helper (satori's VDOM shape — no JSX in a .ts endpoint).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;
const h = (
  type: string,
  style: Record<string, unknown>,
  children?: El | El[]
): El => ({ type, props: { style, ...(children != null ? { children } : {}) } });

function curveAt(
  curve: { date: string; probability: number }[],
  x: number
): number | null {
  const pts = curve
    .map((c) => ({ x: isoToMs(c.date), p: c.probability }))
    .filter((c) => Number.isFinite(c.x))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) return null;
  if (x <= pts[0].x) return pts[0].p;
  const last = pts[pts.length - 1];
  if (x >= last.x) return last.p;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (x >= a.x && x <= b.x)
      return a.p + (b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)) * (b.p - a.p);
  }
  return last.p;
}

export const GET: APIRoute = async ({ params }) => {
  const lang = params.lang as Lang;
  const t = (k: string) => getTranslation(lang, k);
  const data = loadHomePayload(lang);
  const loc = LOCALE[lang];
  const mfmt = new Intl.DateTimeFormat(loc, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const mlabel = (ms: number) => {
    const s = mfmt.format(new Date(ms));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const mkts: HeroMarket[] = data.hero.markets ?? [];
  const curve = data.hero.datasets.ceasefire?.curve ?? [];

  let closest: HeroMarket | null = null;
  let best = Infinity;
  for (const m of mkts) {
    const c = curveAt(curve, m.x);
    if (c === null) continue;
    const d = Math.abs(m.y - c);
    if (d < best) {
      best = d;
      closest = m;
    }
  }
  const now = Date.now();
  const fut = mkts.filter((m) => m.x >= now);
  let opt: HeroMarket | null = null;
  for (const m of fut.length > 0 ? fut : mkts) {
    if (opt === null || m.y > opt.y || (m.y === opt.y && m.x < opt.x)) opt = m;
  }

  const fmt = (m: HeroMarket | null) =>
    m ? `${Math.round(m.y * 100)}% · ${mlabel(m.x)}` : '—';

  const card = (label: string, m: HeroMarket | null): El =>
    h(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        flex: 1,
        border: '1px solid #e3e6ea',
        borderRadius: 10,
        background: '#ffffff',
        padding: '28px 30px',
      },
      [
        h(
          'div',
          {
            display: 'flex',
            fontSize: 22,
            color: '#6c7378',
            letterSpacing: 0.4,
          },
          label
        ),
        h(
          'div',
          {
            display: 'flex',
            fontSize: 46,
            fontWeight: 600,
            color: m ? probColor(m.y) : '#161b20',
          },
          fmt(m)
        ),
      ]
    );

  const tree = h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: '1200px',
      height: '630px',
      background: '#f8fafc',
      color: '#161b20',
      fontFamily: 'Inter',
      padding: 64,
      justifyContent: 'space-between',
    },
    [
      h(
        'div',
        { display: 'flex', alignItems: 'center', gap: 12 },
        [
          h('div', { display: 'flex', width: 22, height: 22, borderRadius: 3, overflow: 'hidden', flexDirection: 'column' }, [
            h('div', { display: 'flex', height: 11, background: '#0057B7' }),
            h('div', { display: 'flex', height: 11, background: '#FFD700' }),
          ]),
          h('div', { display: 'flex', fontSize: 26, fontWeight: 600 }, 'whenwarends.org'),
        ]
      ),
      h(
        'div',
        { display: 'flex', flexDirection: 'column', gap: 22 },
        [
          h(
            'div',
            {
              display: 'flex',
              fontSize: 60,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: -1.4,
              maxWidth: 820,
            },
            t('common.title')
          ),
          h(
            'div',
            {
              display: 'flex',
              fontSize: 25,
              color: '#3d4348',
              lineHeight: 1.45,
              maxWidth: 1000,
            },
            t('common.subtitle')
          ),
        ]
      ),
      h(
        'div',
        { display: 'flex', gap: 24 },
        [card(t('hero.closest'), closest), card(t('hero.optimistic'), opt)]
      ),
    ]
  );

  const svg = await satori(tree, { width: 1200, height: 630, fonts: FONTS });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  })
    .render()
    .asPng();

  return new Response(png as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
