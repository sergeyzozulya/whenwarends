export const languages = {
  uk: 'Українська',
  en: 'English',
  ru: 'Русский',
};

export const defaultLang = 'en';

import uk from './ui/uk.json';
import en from './ui/en.json';
import ru from './ui/ru.json';

export const translations = { uk, en, ru };

export function getLang(lang: keyof typeof languages): string {
  return languages[lang];
}

/**
 * Build a path for a locale. The default locale (en) is served at the root with
 * no prefix; uk/ru are prefixed. localizedPath('en', '/methodology') →
 * '/methodology'; localizedPath('uk', '/methodology') → '/uk/methodology';
 * localizedPath('en') → '/'.
 */
export function localizedPath(lang: keyof typeof languages, path = ''): string {
  const p = path && !path.startsWith('/') ? `/${path}` : path;
  return lang === defaultLang ? p || '/' : `/${lang}${p}`;
}

export function getTranslation(lang: keyof typeof languages, key: string): string {
  const keys = key.split('.');
  let value: unknown = translations[lang];
  for (const k of keys) {
    value = (value as Record<string, unknown> | undefined)?.[k];
  }
  return typeof value === 'string' && value.length > 0 ? value : key;
}
