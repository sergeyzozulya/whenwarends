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

export function getTranslation(lang: keyof typeof languages, key: string): string {
  const keys = key.split('.');
  let value: any = translations[lang];
  for (const k of keys) {
    value = value?.[k];
  }
  return value || key;
}
