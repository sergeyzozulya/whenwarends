// Static /sitemap.xml — every indexable page in all three locales, each with
// the reciprocal hreflang alternate set. URLs use the served (trailing-slash)
// form so the sitemap, the in-page canonical/hreflang, and internal links all
// agree (no redirecting URLs leak to crawlers). Prerendered at build time
// (astro.config `output: 'static'`).
//
// Keep PAGES in sync with the routes under src/pages/[...lang]/ — the og.png and
// chart-data endpoints are assets, not pages, so they are intentionally absent.

import type { APIRoute } from 'astro';
import { localizedPath } from '@i18n/index';
import { LANGS } from '@lib/types';

export const prerender = true;

// '' is the home page; the rest are the transparency/legal pages.
const PAGES = ['', 'about', 'methodology', 'sources', 'changelog', 'privacy'] as const;

export const GET: APIRoute = ({ site }) => {
  // `site` is set in astro.config (`site: 'https://whenwarends.org'`).
  const origin = site ?? new URL('https://whenwarends.org');
  const abs = (lang: (typeof LANGS)[number], page: string): string =>
    new URL(localizedPath(lang, page ? `/${page}` : ''), origin).href;

  const entries = PAGES.map((page) => {
    const alternates = [
      ...LANGS.map(
        (l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${abs(l, page)}"/>`
      ),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${abs('en', page)}"/>`,
    ].join('\n');
    // One <url> per locale; each carries the full reciprocal alternate set.
    return LANGS.map(
      (l) => `  <url>\n    <loc>${abs(l, page)}</loc>\n${alternates}\n  </url>`
    ).join('\n');
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries}
</urlset>
`;

  return new Response(xml, { headers: { 'content-type': 'application/xml' } });
};
