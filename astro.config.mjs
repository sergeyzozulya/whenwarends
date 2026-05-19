import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  site: 'https://whenwarends.org',
  // Pages live at /uk /en /ru only — without this, the bare root 404s
  // (in dev and in production). Send / to the default locale.
  redirects: {
    '/': '/en/',
  },
  integrations: [react()],
  i18n: {
    defaultLocale: 'en',
    locales: ['uk', 'en', 'ru'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // native addon — must not be bundled by the build's SSR step
      external: ['better-sqlite3', '@resvg/resvg-js'],
    },
  },
});
