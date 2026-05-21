import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  site: 'https://whenwarends.org',
  // English (default locale) is served at the root via [...lang] optional-prefix
  // routes; uk/ru are prefixed (/uk, /ru). No root redirect needed.
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
