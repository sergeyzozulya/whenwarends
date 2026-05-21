import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load locale strings via fs (avoids JSON import-attribute friction in the
// Playwright ESM loader; keeps the test in lock-step with the real UI copy).
interface UiStrings {
  common: {
    title: string;
    changelog: string;
    methodology: string;
    about: string;
    sources: string;
  };
  // Section + card headings actually rendered on the homepage (src/pages/[...lang]/index.astro).
  hero: {
    label: string;
    closest: string;
    consensus: string;
    optimistic: string;
  };
  history: { heading: string };
}
const ui = (lang: string): UiStrings =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/i18n/ui', `${lang}.json`), 'utf8')
  ) as UiStrings;

const LOCALES = ['en', 'uk', 'ru'] as const;

// en (default locale) is served at the root; uk/ru are prefixed (no /en).
const homePath = (lang: string): string => (lang === 'en' ? '/' : `/${lang}/`);
const subPath = (lang: string, path: string): string =>
  lang === 'en' ? `/${path}/` : `/${lang}/${path}/`;

// Navigate while pinning the requested locale. The Layout head script
// auto-detects language on first visit and would otherwise redirect a
// prefixed page to the browser default (en in CI), so seed the saved
// preference first to keep the test on the locale under test.
async function visit(page: Page, lang: string, path: string): Promise<void> {
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('lang', l as string);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, lang);
  await page.goto(path);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

for (const lang of LOCALES) {
  const t = ui(lang);
  test.describe(`homepage [${lang}]`, () => {
    test('renders the reading flow with no console errors', async ({ page }) => {
      const errors = collectErrors(page);
      await visit(page, lang, homePath(lang));

      await expect(
        page.getByRole('heading', { level: 1, name: t.common.title })
      ).toBeVisible();

      // The homepage flow: probability section, the three stat cards
      // (closest · consensus · optimistic), then "the war in data".
      for (const heading of [
        t.hero.label,
        t.hero.closest,
        t.hero.consensus,
        t.hero.optimistic,
        t.history.heading,
      ]) {
        await expect(
          page.getByRole('heading', { name: heading })
        ).toBeVisible();
      }

      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('has no serious or critical accessibility violations', async ({
      page,
    }) => {
      await visit(page, lang, homePath(lang));
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      );
      expect(
        blocking,
        blocking.map((v) => `${v.id}: ${v.help}`).join('\n')
      ).toEqual([]);
    });
  });
}

test('root serves the default locale (en) without redirect', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: ui('en').common.title })
  ).toBeVisible();
  // en lives at the root now — there is no /en redirect.
  expect(new URL(page.url()).pathname).toBe('/');
});

test('changelog page renders (entries are data-driven, empty pre-release)', async ({
  page,
}) => {
  await page.goto('/changelog/');
  await expect(
    page.getByRole('heading', { level: 1, name: ui('en').common.changelog })
  ).toBeVisible();
  // data/changelog.json is intentionally empty until a public release; the
  // page must still render its heading without error.
});

// Transparency pages — render in every locale with exactly one <h1> and no
// serious/critical axe violations.
for (const lang of LOCALES) {
  const t = ui(lang);
  for (const [path, heading] of [
    ['methodology', t.common.methodology],
    ['about', t.common.about],
    ['sources', t.common.sources],
  ] as const) {
    test(`${path} [${lang}] renders and is accessible`, async ({ page }) => {
      await visit(page, lang, subPath(lang, path));
      await expect(
        page.getByRole('heading', { level: 1, name: heading })
      ).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      );
      expect(
        blocking,
        blocking.map((v) => `${v.id}: ${v.help}`).join('\n')
      ).toEqual([]);
    });
  }
}
