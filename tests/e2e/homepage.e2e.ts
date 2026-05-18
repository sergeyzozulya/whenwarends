import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load locale strings via fs (avoids JSON import-attribute friction in the
// Playwright ESM loader; keeps the test in lock-step with the real UI copy).
interface UiStrings {
  common: { title: string; changelog: string };
  beliefs: { heading: string };
  events: { heading: string };
  ground: { heading: string };
  brief: { heading: string };
}
const ui = (lang: string): UiStrings =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/i18n/ui', `${lang}.json`), 'utf8')
  ) as UiStrings;

const LOCALES = ['en', 'uk', 'ru'] as const;

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
      await page.goto(`/${lang}/`);

      await expect(
        page.getByRole('heading', { level: 1, name: t.common.title })
      ).toBeVisible();

      for (const heading of [
        t.beliefs.heading,
        t.events.heading,
        t.ground.heading,
        t.brief.heading,
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
      await page.goto(`/${lang}/`);
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

test('root redirects to the default locale', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL(/\/en\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: ui('en').common.title })
  ).toBeVisible();
});

test('changelog page renders (entries are data-driven, empty pre-release)', async ({
  page,
}) => {
  await page.goto('/en/changelog/');
  await expect(
    page.getByRole('heading', { level: 1, name: ui('en').common.changelog })
  ).toBeVisible();
  // data/changelog.json is intentionally empty until a public release; the
  // page must still render its heading without error.
});
