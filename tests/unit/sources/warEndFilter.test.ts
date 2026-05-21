import { describe, it, expect } from 'vitest';
import {
  isWarEndMarket,
  deriveResolutionDate,
} from '../../../src/lib/sources/warEndFilter';

const NOW = '2026-05-20T00:00:00.000Z';

describe('isWarEndMarket', () => {
  it('accepts war-end / ceasefire / peace questions about the conflict', () => {
    expect(isWarEndMarket('Russia x Ukraine ceasefire agreement by Dec 31, 2026?')).toBe(true);
    expect(isWarEndMarket('Will the Russia–Ukraine war end in 2026?')).toBe(true);
    expect(isWarEndMarket('Ukraine signs a peace deal with Russia before 2027?')).toBe(true);
  });

  it('rejects unrelated or excluded questions', () => {
    expect(isWarEndMarket('Will Bitcoin hit $100k in 2026?')).toBe(false); // off-topic
    expect(isWarEndMarket('Will there be a ceasefire in Gaza in 2026?')).toBe(false); // wrong conflict
    expect(isWarEndMarket('Will Russia capture Pokrovsk by July 2026?')).toBe(false); // excluded: capture
    expect(isWarEndMarket('How many drone strikes on Kyiv in 2026?')).toBe(false); // excluded
  });

  it('rejects conditional and tangential framings (Manifold noise)', () => {
    // war-end phrase as a deadline/clause for something else
    expect(isWarEndMarket('Will Joe Biden live to see the Russia-Ukraine war end?')).toBe(false);
    expect(isWarEndMarket('Will Russian top brass die before the end of the war on Ukraine?')).toBe(false);
    expect(isWarEndMarket('If a peace deal ends the Russia Ukraine war, is it brokered by China?')).toBe(false);
    expect(isWarEndMarket('At the end of the war, will Ukraine control any territory?')).toBe(false);
    expect(isWarEndMarket('Will the front line in Ukraine change before the war ends?')).toBe(false);
    expect(isWarEndMarket('By the time a ceasefire is signed, will UA control Crimea?')).toBe(false);
  });
});

describe('deriveResolutionDate', () => {
  it('parses a full month/day/year from the question', () => {
    expect(
      deriveResolutionDate('Ceasefire by December 31, 2026?', { fallbackIso: NOW })
    ).toBe('2026-12-31T00:00:00.000Z');
  });

  it('treats "before <year>" as Dec 31 of the prior year', () => {
    expect(
      deriveResolutionDate('Peace deal before 2027?', { fallbackIso: NOW })
    ).toBe('2026-12-31T00:00:00.000Z');
  });

  it('treats a bare "in/by <year>" as end of that year', () => {
    expect(
      deriveResolutionDate('War ends in 2026?', { fallbackIso: NOW })
    ).toBe('2026-12-31T00:00:00.000Z');
  });

  it('infers the year for a month/day from the close date', () => {
    expect(
      deriveResolutionDate('Ceasefire by August 1?', {
        closeIso: '2027-01-01T00:00:00.000Z',
        fallbackIso: NOW,
      })
    ).toBe('2027-08-01T00:00:00.000Z');
  });

  it('falls back to the close date, then to now', () => {
    expect(
      deriveResolutionDate('Will the war end soon?', {
        closeIso: '2026-09-15T00:00:00.000Z',
        fallbackIso: NOW,
      })
    ).toBe('2026-09-15T00:00:00.000Z');
    expect(
      deriveResolutionDate('Will the war end soon?', { fallbackIso: NOW })
    ).toBe(NOW);
  });
});
