import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  i18n: {
    defaultLocale: 'en',
    locales: ['uk', 'en', 'ru'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  vite: {
    ssr: {
      external: ['better-sqlite3'],
    },
  },
});
