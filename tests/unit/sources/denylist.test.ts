import { describe, it, expect } from 'vitest';
import { isBlockedSource } from '../../../src/lib/sources/denylist';

describe('isBlockedSource — blocks', () => {
  it('Tier 1 exact domain', () => {
    expect(isBlockedSource('rt.com')).toBe('state');
    expect(isBlockedSource('tass.ru')).toBe('state');
    expect(isBlockedSource('cgtn.com')).toBe('state');
  });

  it('Tier 1 subdomain', () => {
    expect(isBlockedSource('francais.rt.com')).toBe('state');
    expect(isBlockedSource('edition.tass.com')).toBe('state');
  });

  it('Tier 2 amplifiers', () => {
    expect(isBlockedSource('thegrayzone.com')).toBe('amplifier');
    expect(isBlockedSource('katehon.com')).toBe('amplifier');
    expect(isBlockedSource('news.thegrayzone.com')).toBe('amplifier');
  });

  it('Pravda network pattern', () => {
    expect(isBlockedSource('pravda-en.com')).toBe('pravda');
    expect(isBlockedSource('pravda-fr.news')).toBe('pravda');
    expect(isBlockedSource('news-pravda-de.info')).toBe('pravda');
  });

  it('Pravda subdomain swarm', () => {
    expect(isBlockedSource('nato.news-pravda.com')).toBe('pravda');
    expect(isBlockedSource('news-pravda.com')).toBe('pravda');
  });

  it('Doppelganger spoof TLDs', () => {
    expect(isBlockedSource('bild.beauty')).toBe('doppelganger');
    expect(isBlockedSource('spiegel.ltd')).toBe('doppelganger');
    expect(isBlockedSource('washingtonpost.pm')).toBe('doppelganger');
  });

  it('strips www. and is case-insensitive', () => {
    expect(isBlockedSource('www.rt.com')).toBe('state');
    expect(isBlockedSource('RT.COM')).toBe('state');
    expect(isBlockedSource('WWW.RT.COM')).toBe('state');
  });
});

describe('isBlockedSource — must NOT block legitimate outlets', () => {
  const legit = [
    'welt.de',
    'repubblica.it',
    'lemonde.fr',
    'bild.de',
    'theguardian.com',
    'washingtonpost.com',
    'pravda.com.ua', // Ukrainska Pravda — legitimate Ukrainian outlet (CRITICAL)
    'kyivindependent.com',
    'unian.net', // a Doppelganger brand stem, but on its real TLD
    'reuters.com',
    'apnews.com',
    'bbc.co.uk',
  ];
  for (const host of legit) {
    it(`${host} -> null`, () => {
      expect(isBlockedSource(host)).toBeNull();
    });
  }

  // Extra-explicit: the Pravda regex must never catch Ukrainska Pravda.
  it('pravda.com.ua is never flagged as the Pravda network', () => {
    expect(isBlockedSource('pravda.com.ua')).toBeNull();
    expect(isBlockedSource('www.pravda.com.ua')).toBeNull();
    expect(isBlockedSource('news.pravda.com.ua')).toBeNull();
  });
});
