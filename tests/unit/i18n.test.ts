import { describe, it, expect } from 'vitest';
import { localizedPath } from '../../src/i18n';

// The site is served in directory format: page URLs carry a trailing slash and
// Cloudflare 301s the slashless form. localizedPath must therefore emit the
// trailing-slash form for pages (so canonical, hreflang, and internal links hit
// the served URL with no redirect) while leaving file assets untouched.
describe('localizedPath — served (directory) trailing-slash form', () => {
  it('roots: en at "/", uk/ru prefixed with a trailing slash', () => {
    expect(localizedPath('en')).toBe('/');
    expect(localizedPath('uk')).toBe('/uk/');
    expect(localizedPath('ru')).toBe('/ru/');
  });

  it('pages end with a slash so links hit the canonical URL (no 301)', () => {
    expect(localizedPath('en', '/methodology')).toBe('/methodology/');
    expect(localizedPath('uk', '/methodology')).toBe('/uk/methodology/');
    expect(localizedPath('ru', '/sources')).toBe('/ru/sources/');
  });

  it('accepts a slashless path argument', () => {
    expect(localizedPath('en', 'about')).toBe('/about/');
  });

  it('file assets keep their extension (no trailing slash)', () => {
    expect(localizedPath('en', '/og.png')).toBe('/og.png');
    expect(localizedPath('uk', '/og.png')).toBe('/uk/og.png');
  });
});
