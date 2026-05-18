import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
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
      external: ['better-sqlite3'],
    },
  },
});
