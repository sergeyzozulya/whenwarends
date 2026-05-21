// Build-time social-share image (Open Graph / Twitter). One PNG per locale,
// regenerated on every build — so it always reflects the latest data. Shows
// the site + headline and the three summary cards (closest / consensus /
// optimistic) with real numbers. satori (layout → SVG) + resvg (SVG → PNG);
// fonts come from @fontsource/inter .woff (satori supports woff, not woff2).

import type { APIRoute } from 'astro';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { loadHomePayload } from '@lib/homepage';
import { probColor } from '@lib/heroChartData';
import { AVERAGE_PATH, OPTIMISTIC_PATH } from '@lib/icons';
import { getTranslation } from '@i18n/index';
import type { Lang } from '@lib/types';

export function getStaticPaths() {
  return [
    { params: { lang: undefined } },
    { params: { lang: 'uk' } },
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

export const GET: APIRoute = async ({ params }) => {
  const lang = (params.lang ?? 'en') as Lang;
  const t = (k: string) => getTranslation(lang, k);
  const data = loadHomePayload(lang);
  const loc = LOCALE[lang];

  const monthFmt = new Intl.DateTimeFormat(loc, { month: 'short', timeZone: 'UTC' });
  const monthUpper = (ms: number) =>
    monthFmt.format(new Date(ms)).replace(/\./g, '').toUpperCase();

  const closest = data.cards.closest;
  const optimistic = data.cards.optimistic;
  const consensus = data.consensus;

  type Kind = 'soonest' | 'average' | 'optimistic';
  const iconSvg = (kind: Kind, color: string): string => {
    if (kind === 'soonest')
      return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="${color}" stroke-width="2"/><path d="M12 12V7M12 12h4" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
    if (kind === 'average')
      return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="${AVERAGE_PATH}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 56 56"><path d="${OPTIMISTIC_PATH}" fill="${color}"/></svg>`;
  };
  const iconImg = (kind: Kind, color: string): El => ({
    type: 'img',
    props: {
      width: 18,
      height: 18,
      src: `data:image/svg+xml;base64,${Buffer.from(iconSvg(kind, color)).toString('base64')}`,
    },
  });

  const card = (
    label: string,
    tag: string,
    kind: Kind,
    price: number | null,
    dateMs: number | null
  ): El => {
    const color = price !== null ? probColor(price) : '#161b20';
    const tagBorder =
      price !== null
        ? probColor(price).replace('rgb(', 'rgba(').replace(')', ',0.35)')
        : '#e3e6ea';
    return h(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        flex: 1,
        border: '1px solid #e3e6ea',
        borderRadius: 10,
        background: '#ffffff',
        padding: '28px 30px',
      },
      [
        h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }, [
          h(
            'div',
            {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${tagBorder}`,
              borderRadius: 4,
              padding: '3px 9px',
              color,
            },
            [iconImg(kind, color), h('div', { display: 'flex', fontSize: 16, color }, tag)]
          ),
          h('div', { display: 'flex', fontSize: 19, color: '#6c7378' }, label),
        ]),
        h('div', { display: 'flex', alignItems: 'center', gap: 14, color }, [
          h('div', { display: 'flex', fontSize: 72 }, price !== null ? `${Math.round(price * 100)}%` : '—'),
          ...(price !== null && dateMs !== null
            ? [
                h(
                  'div',
                  { display: 'flex', flexDirection: 'column', fontSize: 30, lineHeight: 1.05 },
                  [
                    h('div', { display: 'flex' }, monthUpper(dateMs)),
                    h('div', { display: 'flex' }, String(new Date(dateMs).getUTCFullYear())),
                  ]
                ),
              ]
            : []),
        ]),
      ]
    );
  };

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
        {
          display: 'flex',
          fontSize: 56,
          fontWeight: 600,
          lineHeight: 1.12,
          letterSpacing: -1,
          maxWidth: 1000,
        },
        t('common.title')
      ),
      h(
        'div',
        { display: 'flex', gap: 22 },
        [
          card(
            t('hero.closest'),
            t('hero.closestTag'),
            'soonest',
            closest?.price ?? null,
            closest?.dateMs ?? null
          ),
          card(
            t('hero.consensus'),
            t('hero.averageTag'),
            'average',
            consensus?.probability ?? null,
            consensus?.dateMs ?? null
          ),
          card(
            t('hero.optimistic'),
            t('hero.optimisticTag'),
            'optimistic',
            optimistic?.price ?? null,
            optimistic?.dateMs ?? null
          ),
        ]
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
